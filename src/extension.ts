// VSCode client: starts the LSP and exposes interactive Agda commands that
// operate directly on the .lagda.scrbl buffer. Inputs use top quick-inputs
// (input box / quick pick), matching the case-split variable prompt.
import * as path from "path";
import {
  window, commands, languages, ExtensionContext,
  StatusBarItem, StatusBarAlignment, Range, Position,
  CompletionItem, CompletionItemKind, QuickPickItem, TextEditor,
  TextDocument, CancellationToken,
} from "vscode";
import {
  LanguageClient, LanguageClientOptions, ServerOptions, TransportKind,
} from "vscode-languageclient/node";
import { UNICODE } from "./unicode";

let client: LanguageClient;

export function activate(context: ExtensionContext) {
  const module = context.asAbsolutePath(path.join("out", "server.js"));
  const serverOptions: ServerOptions = {
    run:   { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6009"] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", pattern: "**/*.lagda.scrbl" }],
  };
  client = new LanguageClient("agdaScrbl", "Agda (lagda.scrbl)", serverOptions, clientOptions);

  const status: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 0);
  status.command = "agda-scrbl.load";
  context.subscriptions.push(status);

  client.start().then(() => {
    client.onNotification("agda-scrbl/status", (p: any) => {
      switch (p.state) {
        case "checking": status.text = "$(sync~spin) Agda: checking…"; break;
        case "error":    status.text = `$(error) Agda: ${p.errors ?? ""} error${p.errors === 1 ? "" : "s"}`.trimEnd(); break;
        case "done":     status.text = p.goals > 0
                           ? `$(target) Agda: ${p.goals} goal${p.goals === 1 ? "" : "s"}`
                           : "$(check) Agda: All done"; break;
      }
      status.show();
    });
  });

  context.subscriptions.push(
    // palette / keybinding entry points (act on the cursor)
    commands.registerCommand("agda-scrbl.caseSplit", () => caseSplitAt()),
    commands.registerCommand("agda-scrbl.give", () => giveRefineAt("agda-scrbl.exec.give")),
    commands.registerCommand("agda-scrbl.refine", () => giveRefineAt("agda-scrbl.exec.refine")),
    commands.registerCommand("agda-scrbl.goalType", () => goalAt()),
    commands.registerCommand("agda-scrbl.insertSymbol", insertSymbol),
    commands.registerCommand("agda-scrbl.load", () => {
      const ed = window.activeTextEditor;
      if (ed) return commands.executeCommand("agda-scrbl.exec.load", ed.document.uri.toString());
    }),
    // code-action targets (line provided by the action)
    commands.registerCommand("agda-scrbl.caseSplitAt", (uri: string, line: number) => caseSplitAt(uri, line)),
    commands.registerCommand("agda-scrbl.giveAt", (uri: string, line: number) => giveRefineAt("agda-scrbl.exec.give", uri, line)),
    commands.registerCommand("agda-scrbl.refineAt", (uri: string, line: number) => giveRefineAt("agda-scrbl.exec.refine", uri, line)),
    commands.registerCommand("agda-scrbl.goalTypeAt", (uri: string, line: number) => goalAt(uri, line)),
    // inline \to -> → completion
    languages.registerCompletionItemProvider({ pattern: "**/*.lagda.scrbl" }, { provideCompletionItems }, "\\"),
  );
}

function ctx(uri?: string, line?: number): { ed: TextEditor; uri: string; line: number } | undefined {
  const ed = window.activeTextEditor;
  if (!ed) return undefined;
  return { ed, uri: uri ?? ed.document.uri.toString(), line: line ?? ed.selection.active.line };
}

function holeAt(ed: TextEditor, line: number): string {
  const m = ed.document.lineAt(line).text.match(/\{!\s*([\s\S]*?)\s*!\}/);
  return m ? m[1] : "";
}

async function caseSplitAt(uri?: string, line?: number) {
  const c = ctx(uri, line);
  if (!c) return;
  const variable = await window.showInputBox({ prompt: "Variable(s) to case-split" });
  if (!variable) return;
  await commands.executeCommand("agda-scrbl.exec.caseSplit", c.uri, c.line, 0, variable);
}

async function giveRefineAt(exec: string, uri?: string, line?: number) {
  const c = ctx(uri, line);
  if (!c) return;
  const term = await window.showInputBox({
    prompt: exec.endsWith("refine") ? "Refine with term" : "Give term",
    value: holeAt(c.ed, c.line),
  });
  if (term === undefined) return;
  await commands.executeCommand(exec, c.uri, c.line, 0, term);
}

async function goalAt(uri?: string, line?: number) {
  const c = ctx(uri, line);
  if (!c) return;
  const info: any = await commands.executeCommand("agda-scrbl.exec.goalType", c.uri, c.line, 0, "");
  if (!info) { window.showWarningMessage("No goal here."); return; }
  const items: QuickPickItem[] = [
    { label: "$(target) Goal", description: info.type },
    ...info.context.map((e: any) => ({ label: e.name, description: ": " + e.type })),
  ];
  window.showQuickPick(items, { title: `Agda goal ?${info.id}` });
}

async function insertSymbol() {
  const ed = window.activeTextEditor;
  if (!ed) return;
  const items: QuickPickItem[] = UNICODE.map(([abbr, sym]) => ({ label: sym, description: "\\" + abbr }));
  const pick = await window.showQuickPick(items, { title: "Insert Agda symbol", matchOnDescription: true });
  if (pick) ed.edit((b) => b.insert(ed.selection.active, pick.label));
}

function provideCompletionItems(doc: TextDocument, pos: Position, _t: CancellationToken) {
  const upto = doc.lineAt(pos.line).text.slice(0, pos.character);
  const m = upto.match(/\\[A-Za-z0-9^_=<>:|.+\-]*$/);
  if (!m) return undefined;
  const range = new Range(new Position(pos.line, pos.character - m[0].length), pos);
  const items: CompletionItem[] = [];
  for (const [abbr, sym] of UNICODE) {
    const full = "\\" + abbr;
    if (!full.startsWith(m[0])) continue;
    const it = new CompletionItem(full, CompletionItemKind.Text);
    it.detail = sym;
    it.filterText = full;
    it.insertText = sym;
    it.range = range;
    items.push(it);
  }
  return items;
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
