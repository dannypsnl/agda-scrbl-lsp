// VSCode client: starts the LSP and exposes interactive Agda commands that
// operate directly on the .lagda.scrbl buffer. Inputs use top quick-inputs
// (input box / quick pick), matching the case-split variable prompt.
import * as path from "path";
import {
  window, commands, workspace, ExtensionContext,
  StatusBarItem, StatusBarAlignment,
  QuickPick, QuickPickItem, QuickPickItemKind, TextEditor,
} from "vscode";
import {
  LanguageClient, LanguageClientOptions, ServerOptions, TransportKind,
} from "vscode-languageclient/node";
import { Symbol as UnicodeSymbol, loadSymbols, mergeSymbols } from "./unicodeSymbols";
import { Recents, orderByRecents } from "./unicodeRecents";

let client: LanguageClient;

// Bundled + user-defined symbol table, refreshed whenever the user setting
// changes so new entries are picked up without a reload.
let symbols: UnicodeSymbol[] = [];

function loadAllSymbols(context: ExtensionContext): UnicodeSymbol[] {
  const bundled = path.join(context.extensionPath, "resources", "unicode-symbols.json");
  const builtIn = loadSymbols(bundled);
  const userRaw = workspace
    .getConfiguration("agda-scrbl.unicodeInput")
    .get<UnicodeSymbol[]>("userSymbols", []);
  return mergeSymbols(builtIn, userRaw);
}

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

  // Register the handler before start() so early status notifications aren't missed.
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
  client.start().catch((err) =>
    window.showErrorMessage(`Agda (scrbl) language server failed to start: ${err}`));

  symbols = loadAllSymbols(context);

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agda-scrbl.unicodeInput")) symbols = loadAllSymbols(context);
    }),
    // palette / keybinding entry points (act on the cursor)
    commands.registerCommand("agda-scrbl.caseSplit", () => caseSplitAt()),
    commands.registerCommand("agda-scrbl.give", () => giveRefineAt("agda-scrbl.exec.give")),
    commands.registerCommand("agda-scrbl.refine", () => giveRefineAt("agda-scrbl.exec.refine")),
    commands.registerCommand("agda-scrbl.goalType", () => goalAt()),
    commands.registerCommand("agda-scrbl.insertSymbol", () => insertSymbol(context)),
    commands.registerCommand("agda-scrbl.load", () => {
      const ed = window.activeTextEditor;
      if (ed) return commands.executeCommand("agda-scrbl.exec.load", ed.document.uri.toString());
    }),
    // code-action targets (line provided by the action)
    commands.registerCommand("agda-scrbl.caseSplitAt", (uri: string, line: number) => caseSplitAt(uri, line)),
    commands.registerCommand("agda-scrbl.giveAt", (uri: string, line: number) => giveRefineAt("agda-scrbl.exec.give", uri, line)),
    commands.registerCommand("agda-scrbl.refineAt", (uri: string, line: number) => giveRefineAt("agda-scrbl.exec.refine", uri, line)),
    commands.registerCommand("agda-scrbl.goalTypeAt", (uri: string, line: number) => goalAt(uri, line)),
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
  const isRefine = exec.endsWith("refine");
  // agda-mode style: if the hole already holds a term, use it directly; only
  // pop an input box when the hole is empty.
  let term = holeAt(c.ed, c.line).trim();
  if (!term) {
    const input = await window.showInputBox({
      prompt: isRefine ? "Refine with term (blank = introduce)" : "Give term",
    });
    if (input === undefined) return;   // cancelled
    term = input;
  }
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

type SymbolItem = QuickPickItem & { symbol: UnicodeSymbol };

// Sentinel: the user typed a lone `\` inside the picker, meaning "I want a
// literal backslash" — since the `\` key is bound to open this picker, this is
// how you still type the character itself.
const LiteralBackslash = Symbol("agda-scrbl.LiteralBackslash");
type PickResult = UnicodeSymbol | typeof LiteralBackslash | undefined;

// Insert a unicode glyph the agda-mode way: bound to `\`, so pressing backslash
// pops this picker inline (no command palette). Type the abbrev (`to`, `lambda`)
// and accept to drop the glyph at the cursor. Most-recently-used glyphs float to
// the top under a "recent" separator. Modelled on vscode-violet.
async function insertSymbol(context: ExtensionContext) {
  const ed = window.activeTextEditor;
  if (!ed) return;

  const recents = new Recents(context.globalState);
  const { ordered, recentCount } = orderByRecents(symbols, recents.list());

  const items: SymbolItem[] = ordered.map((s) => ({
    label: s.glyph,
    description: s.name,
    detail: (s.aliases ?? []).join(", "),
    symbol: s,
  }));
  // Separators only make sense unfiltered; drop them once the user types so they
  // don't clutter the filtered list.
  const sectioned: (SymbolItem | QuickPickItem)[] =
    recentCount > 0
      ? [
          { label: "recent", kind: QuickPickItemKind.Separator },
          ...items.slice(0, recentCount),
          { label: "symbols", kind: QuickPickItemKind.Separator },
          ...items.slice(recentCount),
        ]
      : items;

  const chosen = await new Promise<PickResult>((resolve) => {
    let done = false;
    const qp: QuickPick<SymbolItem | QuickPickItem> = window.createQuickPick();
    qp.placeholder = "Type an abbrev (to, lambda, bN). Type \\ for a literal backslash.";
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.items = sectioned;
    qp.onDidChangeValue((v) => {
      if (v === "\\") { done = true; qp.hide(); resolve(LiteralBackslash); return; }
      qp.items = v.length === 0 ? sectioned : items;
    });
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0] as SymbolItem | undefined;
      done = true;
      qp.hide();
      resolve(sel?.symbol);
    });
    qp.onDidHide(() => { qp.dispose(); if (!done) resolve(undefined); });
    qp.show();
  });

  if (chosen === undefined) return;
  if (chosen === LiteralBackslash) {
    await ed.edit((b) => b.insert(ed.selection.active, "\\"));
    return;
  }
  await ed.edit((b) => b.insert(ed.selection.active, chosen.glyph));
  await recents.push(chosen.name);
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
