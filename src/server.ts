// LSP server for .lagda.scrbl — drives agda --interaction-json on a
// line-preserved .lagda.md mirror and surfaces goals/errors/case-split.
import {
  createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind,
  DiagnosticSeverity, Diagnostic, Hover, InitializeResult, TextEdit,
  ApplyWorkspaceEditParams, CodeAction, CodeActionKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath } from "url";
import { readdirSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { dirname, basename, resolve } from "path";
import { mirror, indentOf } from "./mirror";
import { Agda } from "./agda";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

interface Session { agda: Agda; root: string; mirror: string; indents: number[]; }
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
  const agda = new Agda(mirror, root, "agda", (m) => connection.console.log("[agda] " + m.trim()));
  s = { agda, root, mirror, indents: [] };
  sessions.set(doc.uri, s);
  return s;
}

function prettify(msg: string, mirror: string): string {
  return msg.split(mirror).join(basename(mirror)).replace(/^[^\n]*:\d+\.\d+(-\d+(\.\d+)?)?: /, "");
}

async function reload(doc: TextDocument, expand = false) {
  const s = sessionFor(doc);
  connection.sendNotification("agda-scrbl/status", { uri: doc.uri, state: "checking" });
  let goals, errors;
  try {
    const m = mirror(doc.getText());
    s.indents = m.indents;
    writeFileSync(s.mirror, m.text + "\n");
    ({ goals, errors } = await s.agda.load());
  } catch (err) {
    connection.sendNotification("agda-scrbl/status",
      { uri: doc.uri, state: "error", message: String(err) });
    throw err;
  }
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

connection.onInitialize((): InitializeResult => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Full,
    hoverProvider: true,
    codeActionProvider: true,
    executeCommandProvider: { commands: [
      "agda-scrbl.exec.caseSplit", "agda-scrbl.exec.give",
      "agda-scrbl.exec.refine", "agda-scrbl.exec.goalType", "agda-scrbl.exec.load",
    ] },
  },
}));

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

  const [uri, line, char, variable] = params.arguments as [string, number, number, string?];
  const doc = documents.get(uri);
  const s = sessions.get(uri);
  if (!doc || !s) return;
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
