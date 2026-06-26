// Regenerate resources/unicode-symbols.json from the full Agda input table.
//
// Source of truth: banacorn's agda-mode-vscode ships the complete Agda input
// translation table (the same one Agda's Emacs `agda-input.el` uses) as a clean
// reverse index in `asset/query.js`: { "<codepoint>": ["abbrev", ...], ... }.
// We invert it into our { name, glyph, aliases? } shape so this extension's `\`
// picker is a drop-in replacement for agda-mode — letting users uninstall it.
//
// agda-mode-vscode is MIT (Copyright (c) 2020 Ting-gian LUA); the underlying
// table comes from Agda (permissive). This generator + its output are derived
// works under those terms.
//
// Run:  bun run scripts/gen-unicode-symbols.ts [path/to/agda-mode/asset/query.js]
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const DEFAULT_SRC =
  "/Users/dannypsnl/.vscode/extensions/banacorn.agda-mode-0.10.0/asset/query.js";
const src = process.argv[2] ?? DEFAULT_SRC;

// query.js is CommonJS (`module.exports.default = {...}`); evaluate it in a
// throwaway module sandbox rather than depending on require() resolution.
const sandbox = { exports: {} as { default?: Record<string, string[]> } };
new Function("module", "exports", readFileSync(src, "utf8"))(sandbox, sandbox.exports);
const table = sandbox.exports.default;
if (!table) throw new Error(`no default export in ${src}`);

// Glyphs we want under an extra abbreviation beyond agda-mode's (TypeTopology
// universes are typed \McU.. in this project; agda-mode only lists \MCU..).
const EXTRA_ALIAS: Record<string, string> = {
  "𝓤": "McU", "𝓥": "McV", "𝓦": "McW", "𝓣": "McT", "𝓞": "McO",
};

interface Sym { name: string; glyph: string; aliases?: string[]; }

const out: Sym[] = [];
for (const cp of Object.keys(table)) {
  const code = Number(cp);
  if (code < 32) continue; // skip control chars (e.g. \newline -> U+000A)
  const glyph = String.fromCodePoint(code);
  const abbrevs = [...new Set(table[cp])]; // dedup, preserve order
  const extra = EXTRA_ALIAS[glyph];
  if (extra && !abbrevs.includes(extra)) abbrevs.push(extra);
  const [name, ...aliases] = abbrevs;
  if (!name) continue;
  out.push(aliases.length ? { name, glyph, aliases } : { name, glyph });
}

// One object per line: compact but diff-friendly. Keys are codepoint-ordered, so
// related glyphs (all arrows, all greek) stay grouped in the picker.
const json = "[\n" + out.map((e) => "  " + JSON.stringify(e)).join(",\n") + "\n]\n";
const dest = resolve(import.meta.dir, "../resources/unicode-symbols.json");
writeFileSync(dest, json);
console.log(`wrote ${out.length} symbols -> ${dest}`);
