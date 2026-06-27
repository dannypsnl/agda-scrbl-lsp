// LSP server for .lagda.scrbl — drives agda --interaction-json on a
// line-preserved .lagda.md mirror and surfaces goals/errors/case-split.
import {
  createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind,
  DiagnosticSeverity, Diagnostic, Hover, InitializeResult, TextEdit,
  ApplyWorkspaceEditParams, CodeAction, CodeActionKind,
  SemanticTokensBuilder, Location,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath, pathToFileURL } from "url";
import { readdirSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { dirname, basename, resolve } from "path";
import { mirror, indentOf } from "./mirror";
import { Agda, DEFAULT_LOAD_TIMEOUT, HighlightToken, DefinitionSite } from "./agda";

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

// A highlighted span in scrbl coordinates. `type` is -1 when no aspect maps to a
// semantic token (we still keep the span if it carries a `def` for goto).
interface ScrblSpan {
  line: number; char: number; length: number;
  type: number;
  def?: DefinitionSite;
}

// An index over a mirror's text that turns Agda's 1-based code-point offsets into
// (line, code-point-column). The mirror is line-preserved, so its line is the
// scrbl line; the column still needs the stripped indent added back.
interface MirrorIndex { lineStart: number[]; lineLen: number[]; total: number; }
function mirrorIndex(mirrorText: string): MirrorIndex {
  const lines = mirrorText.split("\n");
  const lineStart = new Array<number>(lines.length + 1);
  const lineLen = new Array<number>(lines.length);
  let acc = 0;
  for (let l = 0; l < lines.length; l++) {
    lineStart[l] = acc;
    lineLen[l] = [...lines[l]].length;
    acc += lineLen[l] + 1;
  }
  lineStart[lines.length] = acc;
  return { lineStart, lineLen, total: acc };
}

// Locate the line owning 0-based code-point offset `idx` (binary search).
function lineOfOffset(ix: MirrorIndex, idx: number): number {
  let lo = 0, hi = ix.lineLen.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ix.lineStart[mid] <= idx) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Mirror code-point offset (1-based, as Agda reports) -> scrbl position, adding
// back the indent stripped from that line. null if out of range.
function mirrorOffsetToScrbl(
  ix: MirrorIndex, indents: number[], position1: number,
): { line: number; character: number } | null {
  const idx = position1 - 1;
  if (idx < 0 || idx > ix.total) return null;
  const line = lineOfOffset(ix, idx);
  return { line, character: (idx - ix.lineStart[line]) + (indents[line] ?? 0) };
}

// Convert Agda's highlighting payload to scrbl spans. Multi-line tokens are
// clamped to their first line — LSP semantic tokens may not span lines.
function toScrblSpans(
  highlights: HighlightToken[], ix: MirrorIndex, indents: number[],
): ScrblSpan[] {
  const out: ScrblSpan[] = [];
  for (const h of highlights) {
    const type = tokenTypeFor(h.atoms);
    if (type < 0 && !h.definitionSite) continue;   // nothing useful to surface
    const idx = h.from - 1;
    if (idx < 0 || idx >= ix.total) continue;
    const line = lineOfOffset(ix, idx);
    const col = idx - ix.lineStart[line];
    const length = Math.min(h.to - h.from, ix.lineLen[line] - col);   // clamp to line
    if (length <= 0) continue;
    out.push({ line, char: col + (indents[line] ?? 0), length, type, def: h.definitionSite });
  }
  out.sort((a, b) => a.line - b.line || a.char - b.char);
  return out;
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// How long to wait for `agda` to answer a load before reporting it unresponsive.
// Overridable via the client's initializationOptions (agda-scrbl.loadTimeout).
let loadTimeoutMs = DEFAULT_LOAD_TIMEOUT;

interface Session {
  agda: Agda; root: string; mirror: string; indents: number[];
  uri: string;            // the .lagda.scrbl document this session serves
  spans: ScrblSpan[];     // highlighting spans from the last load (scrbl coords)
  ix: MirrorIndex;        // offset index over the last mirror text (for goto)
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
        connection.sendNotification("agda-scrbl/status",
          { uri, state: "error", message: reason, notify: true });
    },
    // Live type-checking progress: forward each "Checking Foo …" line as a
    // status detail (ignored if a newer session has taken over the document).
    (message) => {
      const detail = shortProgress(message);
      if (detail && sessions.get(uri)?.agda === agda)
        connection.sendNotification("agda-scrbl/status", { uri, state: "checking", detail });
    },
  );
  s = { agda, root, mirror, indents: [], uri: doc.uri, spans: [], ix: mirrorIndex("") };
  sessions.set(doc.uri, s);
  return s;
}

function prettify(msg: string, mirror: string): string {
  return msg.split(mirror).join(basename(mirror)).replace(/^[^\n]*:\d+\.\d+(-\d+(\.\d+)?)?: /, "");
}

// A RunningInfo line ("Checking Foo (/abs/path).\n") -> a short progress label
// ("Checking Foo"); drops the parenthesised path and trailing punctuation.
function shortProgress(message: string): string {
  return message.split("\n")[0].trim().replace(/\s*\([^)]*\)\s*\.?$/, "").trim();
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
        { uri: doc.uri, state: "error", message: err instanceof Error ? err.message : String(err), notify: true });
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
    // Full messages for a popup, and whether to actually pop it: only on an
    // explicit load/open/restart, never on the debounced reload while typing.
    details: errors.length ? errors.map((e) => prettify(e.message, s.mirror)) : undefined,
    notify: errors.length ? expand : undefined,
  });

  // Refresh syntax colouring from this load's highlighting. Even a file with
  // errors gets coloured up to the point Agda could scope-check.
  s.ix = mirrorIndex(mirrorText);
  s.spans = toScrblSpans(s.agda.highlights, s.ix, s.indents);
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
      definitionProvider: true,
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
  if (s) {
    // Spans are already sorted; Agda's token + scope passes can emit the same
    // keyword/symbol twice, so skip an exact-duplicate of the previous one.
    let pl = -1, pc = -1, pn = -1, pt = -1;
    for (const t of s.spans) {
      if (t.type < 0) continue;
      if (t.line === pl && t.char === pc && t.length === pn && t.type === pt) continue;
      b.push(t.line, t.char, t.length, t.type, 0);
      pl = t.line; pc = t.char; pn = t.length; pt = t.type;
    }
  }
  return b.build();
});

// Resolve a token's definitionSite to a scrbl/file Location. A target inside a
// known mirror (this doc's or another open scrbl's) maps back to the .scrbl;
// anything else (library .agda sources) points at the real file. The returned
// range is zero-width at the definition's first character.
function resolveDefinition(def: DefinitionSite): Location | null {
  for (const s of sessions.values()) {
    if (s.mirror === def.filepath) {
      const pos = mirrorOffsetToScrbl(s.ix, s.indents, def.position);
      return pos ? { uri: s.uri, range: { start: pos, end: pos } } : null;
    }
  }
  // A real file on disk (a library, or a mirror with no open session): convert
  // the code-point offset against its current contents.
  let text: string;
  try { text = readFileSync(def.filepath, "utf8"); } catch { return null; }
  const ix = mirrorIndex(text);
  const pos = mirrorOffsetToScrbl(ix, [], def.position);
  return pos ? { uri: pathToFileURL(def.filepath).href, range: { start: pos, end: pos } } : null;
}

connection.onDefinition((params): Location | null => {
  const s = sessions.get(params.textDocument.uri);
  if (!s) return null;
  const { line, character } = params.position;
  // Innermost span under the cursor that carries a definition.
  let hit: ScrblSpan | undefined;
  for (const sp of s.spans) {
    if (!sp.def || sp.line !== line) continue;
    if (character < sp.char || character > sp.char + sp.length) continue;
    if (!hit || sp.length < hit.length) hit = sp;
  }
  return hit ? resolveDefinition(hit.def!) : null;
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
