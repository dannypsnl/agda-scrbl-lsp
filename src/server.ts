// LSP server for .lagda.scrbl — drives agda --interaction-json on a
// line-preserved .lagda.md mirror and surfaces goals/errors/case-split.
import {
  createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind,
  DiagnosticSeverity, Diagnostic, Hover, InitializeResult, TextEdit,
  ApplyWorkspaceEditParams, CodeAction, CodeActionKind,
  SemanticTokensBuilder,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath } from "url";
import { readdirSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { dirname, basename, resolve } from "path";
import { mirror, indentOf } from "./mirror";
import { Agda, DEFAULT_LOAD_TIMEOUT, HighlightToken } from "./agda";

// --- Semantic highlighting -------------------------------------------------
// Agda colours code by "aspect" (keyword, function, datatype, …). We surface
// these as LSP semantic tokens; the editor theme decides the actual colour.
// The legend order defines the integer ids encoded in the token stream.
const TOKEN_TYPES = [
  "namespace", "type", "enumMember", "property", "function", "macro",
  "keyword", "operator", "variable", "parameter", "typeParameter",
  "string", "number", "comment",
];
const TOKEN_TYPE_ID = new Map(TOKEN_TYPES.map((t, i) => [t, i]));
const SEMANTIC_LEGEND = { tokenTypes: TOKEN_TYPES, tokenModifiers: [] as string[] };

// Map an Agda aspect to an LSP token type. A payload's `atoms` may carry several
// aspects (e.g. an operator that is also a function); we pick the most specific
// in this preference order.
const ATOM_TO_TYPE: Record<string, string> = {
  function: "function", postulate: "function",
  datatype: "type", record: "type", primitive: "type",   // Set/Prop/sorts read as types
  inductiveconstructor: "enumMember", coinductiveconstructor: "enumMember",
  field: "property", module: "namespace", macro: "macro",
  generalizable: "typeParameter", argument: "parameter", bound: "variable",
  keyword: "keyword", symbol: "operator", string: "string", number: "number",
  comment: "comment", pragma: "macro",
};
const ATOM_PREFERENCE = [
  "function", "postulate", "datatype", "record", "primitive",
  "inductiveconstructor", "coinductiveconstructor", "field", "module", "macro",
  "generalizable", "argument", "bound", "keyword", "symbol",
  "string", "number", "comment", "pragma",
];
function tokenTypeFor(atoms: string[]): number {
  for (const a of ATOM_PREFERENCE)
    if (atoms.includes(a)) return TOKEN_TYPE_ID.get(ATOM_TO_TYPE[a])!;
  return -1;
}

interface ScrblToken { line: number; char: number; length: number; type: number; }

// Convert Agda's 1-based code-point offsets (into the mirror) to scrbl semantic
// tokens. The mirror is line-preserved, so the line is identity; the column gets
// the stripped indent added back (same recovery as scrblCol). Multi-line tokens
// are clamped to their first line — LSP semantic tokens may not span lines.
function toScrblTokens(
  highlights: HighlightToken[], mirrorText: string, indents: number[],
): ScrblToken[] {
  const lines = mirrorText.split("\n");
  // 0-based code-point offset where each line starts; one extra entry past the end.
  const lineStart = new Array<number>(lines.length + 1);
  let acc = 0;
  for (let l = 0; l < lines.length; l++) { lineStart[l] = acc; acc += [...lines[l]].length + 1; }
  lineStart[lines.length] = acc;

  const lineOf = (idx: number): number => {
    let lo = 0, hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStart[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  const out: ScrblToken[] = [];
  for (const h of highlights) {
    const type = tokenTypeFor(h.atoms);
    if (type < 0) continue;
    const idx = h.from - 1;                       // 0-based start offset
    if (idx < 0 || idx >= acc) continue;
    const line = lineOf(idx);
    const col = idx - lineStart[line];
    const lineLen = [...lines[line]].length;
    const length = Math.min(h.to - h.from, lineLen - col);   // clamp to this line
    if (length <= 0) continue;
    out.push({ line, char: col + (indents[line] ?? 0), length, type });
  }
  // SemanticTokensBuilder needs tokens in document order. Agda runs a token pass
  // and a scope pass, so identical tokens (keywords, symbols) can arrive twice;
  // drop exact duplicates after sorting.
  out.sort((a, b) => a.line - b.line || a.char - b.char || a.length - b.length || a.type - b.type);
  return out.filter((t, i) => {
    const p = out[i - 1];
    return !p || p.line !== t.line || p.char !== t.char || p.length !== t.length || p.type !== t.type;
  });
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// How long to wait for `agda` to answer a load before reporting it unresponsive.
// Overridable via the client's initializationOptions (agda-scrbl.loadTimeout).
let loadTimeoutMs = DEFAULT_LOAD_TIMEOUT;

interface Session {
  agda: Agda; root: string; mirror: string; indents: number[];
  tokens: ScrblToken[];   // semantic tokens from the last load (scrbl coords)
}
const sessions = new Map<string, Session>();

// Agda reports columns against the dedented mirror; add back the indent stripped
// from that line to land on the scrbl column. line is 0-based.
function scrblCol(s: Session, line: number, agdaCol1Based: number): number {
  return agdaCol1Based - 1 + (s.indents[line] ?? 0);
}
const debounce = new Map<string, NodeJS.Timeout>();

function hasAgdaLib(dir: string): boolean {
  try { return readdirSync(dir).some((f) => f.endsWith(".agda-lib")); }
  catch { return false; }
}

// nearest ancestor dir containing a *.agda-lib (the Agda project root)
function projectRoot(file: string): string {
  let dir = dirname(file);
  for (;;) {
    if (hasAgdaLib(dir)) return dir;
    const up = dirname(dir);
    if (up === dir) return dirname(file);
    dir = up;
  }
}

function sessionFor(doc: TextDocument): Session {
  let s = sessions.get(doc.uri);
  if (s) return s;
  const file = fileURLToPath(doc.uri);
  const root = projectRoot(file);
  const name = basename(file).replace(/\.lagda\.scrbl$/, ".agda");
  const mirror = resolve(root, "_tmp/mirror", name);
  mkdirSync(dirname(mirror), { recursive: true });
  // drop a stale legacy mirror of the same module (pre-.agda builds wrote .lagda.md)
  rmSync(mirror.replace(/\.agda$/, ".lagda.md"), { force: true });
  const uri = doc.uri;
  const agda = new Agda(
    mirror, root, "agda",
    (m) => connection.console.log("[agda] " + m.trim()),
    // The process died unexpectedly: surface the reason so the status bar stops
    // spinning on "checking" and the user can restart. Ignore if a newer session
    // has already taken over this document.
    (reason) => {
      if (sessions.get(uri)?.agda === agda)
        connection.sendNotification("agda-scrbl/status", { uri, state: "error", message: reason });
    },
  );
  s = { agda, root, mirror, indents: [], tokens: [] };
  sessions.set(doc.uri, s);
  return s;
}

function prettify(msg: string, mirror: string): string {
  return msg.split(mirror).join(basename(mirror)).replace(/^[^\n]*:\d+\.\d+(-\d+(\.\d+)?)?: /, "");
}

async function reload(doc: TextDocument, expand = false) {
  const s = sessionFor(doc);
  // If this session gets disposed/replaced mid-load (e.g. a Restart Agda), its
  // late notifications must not clobber the fresh session's status.
  const current = () => sessions.get(doc.uri) === s;
  connection.sendNotification("agda-scrbl/status", { uri: doc.uri, state: "checking" });
  let goals, errors;
  let mirrorText = "";
  try {
    const m = mirror(doc.getText());
    mirrorText = m.text;
    s.indents = m.indents;
    writeFileSync(s.mirror, m.text + "\n");
    ({ goals, errors } = await s.agda.load(loadTimeoutMs));
  } catch (err) {
    if (current())
      connection.sendNotification("agda-scrbl/status",
        { uri: doc.uri, state: "error", message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  if (!current()) return;
  const diags: Diagnostic[] = [];
  for (const g of goals) {
    const gl = g.line - 1;
    diags.push({
      severity: DiagnosticSeverity.Information,
      range: { start: { line: gl, character: scrblCol(s, gl, g.startCol) },
               end:   { line: gl, character: scrblCol(s, gl, g.endCol) } },
      message: `?${g.id} : ${g.type}`,
      source: "agda",
    });
  }
  for (const e of errors) {
    const line = (e.line ?? 1) - 1;
    const endLine = (e.endLine ?? e.line ?? 1) - 1;
    diags.push({
      severity: DiagnosticSeverity.Error,
      range: { start: { line, character: scrblCol(s, line, e.startCol ?? 1) },
               end:   { line: endLine, character: scrblCol(s, endLine, e.endCol ?? 1) } },
      message: prettify(e.message, s.mirror),
      source: "agda",
    });
  }
  connection.sendDiagnostics({ uri: doc.uri, diagnostics: diags });
  connection.sendNotification("agda-scrbl/status", {
    uri: doc.uri,
    state: errors.length ? "error" : "done",
    goals: goals.length,
    errors: errors.length,
  });

  // Refresh syntax colouring from this load's highlighting. Even a file with
  // errors gets coloured up to the point Agda could scope-check.
  s.tokens = toScrblTokens(s.agda.highlights, mirrorText, s.indents);
  // Ask the client to re-pull tokens; harmless if it lacks the capability.
  try { connection.languages.semanticTokens.refresh(); } catch { /* ignore */ }

  // agda-mode behaviour: on an explicit load, expand bare `?` into `{!  !}`
  // so each goal becomes an editable hole. Only on load — never while typing.
  if (expand) {
    const edits: TextEdit[] = [];
    for (const g of goals) {
      const gl = g.line - 1;
      const r = { start: { line: gl, character: scrblCol(s, gl, g.startCol) },
                  end:   { line: gl, character: scrblCol(s, gl, g.endCol) } };
      if (doc.getText(r) === "?") edits.push(TextEdit.replace(r, "{!  !}"));
    }
    if (edits.length) {
      await connection.workspace.applyEdit({ edit: { changes: { [doc.uri]: edits } } });
    }
  }
}

function scheduleReload(doc: TextDocument) {
  const prev = debounce.get(doc.uri);
  if (prev) clearTimeout(prev);
  debounce.set(doc.uri, setTimeout(() => reload(doc).catch((e) => connection.console.error(String(e))), 400));
}

connection.onInitialize((params): InitializeResult => {
  const lt = (params.initializationOptions as any)?.loadTimeout;
  if (typeof lt === "number" && lt > 0) loadTimeoutMs = lt * 1000;
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      hoverProvider: true,
      codeActionProvider: true,
      semanticTokensProvider: { legend: SEMANTIC_LEGEND, full: true },
      executeCommandProvider: { commands: [
        "agda-scrbl.exec.caseSplit", "agda-scrbl.exec.give",
        "agda-scrbl.exec.refine", "agda-scrbl.exec.goalType",
        "agda-scrbl.exec.load", "agda-scrbl.exec.restart",
      ] },
    },
  };
});

documents.onDidOpen((e) => reload(e.document, true).catch((err) => connection.console.error(String(err))));
documents.onDidChangeContent((e) => scheduleReload(e.document));
documents.onDidClose((e) => {
  // Cancel any pending debounced reload — otherwise it fires after close,
  // re-creates the session via sessionFor(), and leaks a fresh agda process.
  const pending = debounce.get(e.document.uri);
  if (pending) { clearTimeout(pending); debounce.delete(e.document.uri); }
  const s = sessions.get(e.document.uri);
  if (s) { s.agda.dispose(); sessions.delete(e.document.uri); }
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

connection.onCodeAction((params): CodeAction[] => {
  const uri = params.textDocument.uri;
  const s = sessions.get(uri);
  if (!s) return [];
  const { start, end } = params.range;
  const actions: CodeAction[] = [];
  for (const g of s.agda.goals) {
    if (g.line - 1 < start.line || g.line - 1 > end.line) continue;
    actions.push(
      { title: `Agda: Goal type & context (?${g.id})`, kind: CodeActionKind.RefactorRewrite,
        command: { title: "Goal type", command: "agda-scrbl.goalTypeAt", arguments: [uri, g.line - 1] } },
      { title: `Agda: Case split (?${g.id})…`, kind: CodeActionKind.RefactorRewrite,
        command: { title: "Case split", command: "agda-scrbl.caseSplitAt", arguments: [uri, g.line - 1] } },
      { title: `Agda: Give (?${g.id})…`, kind: CodeActionKind.RefactorRewrite,
        command: { title: "Give", command: "agda-scrbl.giveAt", arguments: [uri, g.line - 1] } },
      { title: `Agda: Refine (?${g.id})…`, kind: CodeActionKind.RefactorRewrite,
        command: { title: "Refine", command: "agda-scrbl.refineAt", arguments: [uri, g.line - 1] } },
    );
  }
  return actions;
});

connection.languages.semanticTokens.on((params) => {
  const s = sessions.get(params.textDocument.uri);
  const b = new SemanticTokensBuilder();
  if (s) for (const t of s.tokens) b.push(t.line, t.char, t.length, t.type, 0);
  return b.build();
});

connection.onHover((p): Hover | null => {
  const s = sessions.get(p.textDocument.uri);
  if (!s) return null;
  const g = s.agda.goals.find((g) => g.line - 1 === p.position.line);
  if (!g) return null;
  return { contents: { kind: "markdown", value: "```agda\n?" + g.id + " : " + g.type + "\n```" } };
});

const HOLE = /^\{!\s*([\s\S]*?)\s*!\}$/;

async function applyEdit(uri: string, edits: TextEdit[]) {
  const params: ApplyWorkspaceEditParams = { edit: { changes: { [uri]: edits } } };
  await connection.workspace.applyEdit(params);
}

connection.onExecuteCommand(async (params) => {
  const cmd = params.command;
  if (cmd === "agda-scrbl.exec.load") {
    const [uri] = params.arguments as [string];
    const doc = documents.get(uri);
    if (doc) await reload(doc, true);   // explicit load -> expand ? into {!  !}
    return;
  }

  // One-click recovery for a wedged process: tear down the old session (killing
  // its agda) and load again from a fresh one — no window reload needed.
  if (cmd === "agda-scrbl.exec.restart") {
    const [uri] = params.arguments as [string];
    const doc = documents.get(uri);
    if (!doc) return;
    const old = sessions.get(uri);
    if (old) { old.agda.dispose(); sessions.delete(uri); }
    await reload(doc, true);   // sessionFor() spins up a new agda
    return;
  }

  const [uri, line, char, variable] = params.arguments as [string, number, number, string?];
  const doc = documents.get(uri);
  const s = sessions.get(uri);
  if (!doc || !s) return;
  if (s.agda.dead) {
    connection.window.showWarningMessage(
      `Agda is not running (${s.agda.deadReason}). Run “Agda (scrbl): Restart Agda”.`);
    return;
  }
  // Use the goals from the last load (open/edit/explicit-load already keep them
  // fresh). NEVER block on a reload here — a cold first load takes minutes and
  // would make the command feel dead.
  const goals = s.agda.goals;
  connection.console.log(
    `[cmd ${cmd}] cursor L${line}C${char}; goals=[${goals.map((g) => `L${g.line - 1}`).join(",")}]`);
  if (goals.length === 0) {
    connection.window.showWarningMessage(
      "No goals yet — wait for the load to finish (status bar), or run Load (Ctrl-C Ctrl-L).");
    return;
  }
  // forgiving: cursor inside a goal's range, else any goal on the line, else the
  // sole goal in the file.
  const g =
    goals.find((g) => g.line - 1 === line &&
      scrblCol(s, line, g.startCol) <= char && char <= scrblCol(s, line, g.endCol)) ??
    goals.find((g) => g.line - 1 === line) ??
    (goals.length === 1 ? goals[0] : undefined);
  if (!g) {
    connection.window.showWarningMessage(
      `No goal here. Goals are on line(s) ${goals.map((g) => g.line).join(", ")}.`);
    return;
  }
  const gl = g.line - 1;
  const holeRange = {
    start: { line: gl, character: scrblCol(s, gl, g.startCol) },
    end: { line: gl, character: scrblCol(s, gl, g.endCol) },
  };

  if (cmd === "agda-scrbl.exec.goalType") {
    return await s.agda.goalTypeContext(g.id);   // returned to the client
  }

  if (cmd === "agda-scrbl.exec.caseSplit") {
    const mc = await s.agda.makeCase(g.id, variable!);
    if (!mc) { connection.window.showWarningMessage("case-split produced nothing."); return; }
    const target = mc.line - 1;                         // == scrbl line (identity)
    const indent = indentOf(doc.getText({
      start: { line: target, character: 0 }, end: { line: target + 1, character: 0 } }));
    const text = mc.clauses.map((c) => indent + c).join("\n") + "\n";
    await applyEdit(uri, [TextEdit.replace(
      { start: { line: target, character: 0 }, end: { line: target + 1, character: 0 } }, text)]);

  } else if (cmd === "agda-scrbl.exec.give" || cmd === "agda-scrbl.exec.refine") {
    const isRefine = cmd.endsWith("refine");
    // The client prompts for a term and passes it as `variable`; prefer it, and
    // fall back to whatever is literally inside the {! !} hole otherwise.
    const raw = doc.getText(holeRange);
    const m = HOLE.exec(raw);
    const fromHole = m ? m[1] : raw.replace(/^\?/, "").trim();
    const content = (variable ?? "").trim() || fromHole;
    // give must place a term; refine with no term is a valid "introduce" step.
    if (!isRefine && !content) {
      connection.window.showWarningMessage("give needs a term."); return;
    }
    const res = isRefine ? await s.agda.refine(g.id, content) : await s.agda.give(g.id, content);
    if (!res) {
      connection.window.showWarningMessage(
        `${isRefine ? "refine" : "give"} produced nothing (does it type-check?).`); return;
    }
    const rl = res.line - 1;
    await applyEdit(uri, [TextEdit.replace({
      start: { line: rl, character: scrblCol(s, rl, res.startCol) },
      end: { line: rl, character: scrblCol(s, rl, res.endCol) },
    }, res.str)]);
  }
});

documents.listen(connection);
connection.listen();
