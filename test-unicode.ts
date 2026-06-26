// Unit tests for the unicode-input modules (loader, merge, recents ordering).
// Pure logic, no VSCode. Run with: bun run test-unicode.ts
import { resolve } from "path";
import { loadSymbols, mergeSymbols, Symbol as Sym } from "./src/unicodeSymbols";
import { Recents, orderByRecents, MementoLike } from "./src/unicodeRecents";

let failures = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`✗ ${name}\n    got:  ${g}\n    want: ${w}`); }
  else console.log(`✓ ${name}`);
}

// --- loadSymbols (full Agda input table, generated from agda-mode) ---
const bundled = resolve(import.meta.dir, "resources/unicode-symbols.json");
const syms = loadSymbols(bundled);
eq("bundled table is comprehensive (>2000 symbols)", syms.length > 2000, true);
const keys = (g: string) => { const s = syms.find((x) => x.glyph === g); return s ? [s.name, ...(s.aliases ?? [])] : []; };
eq("→ reachable by 'to' and 'rightarrow'", keys("→").includes("to") && keys("→").includes("rightarrow"), true);
eq("λ reachable by 'lambda'", keys("λ").includes("lambda"), true);
eq("𝓤 reachable by 'McU' (project alias) and 'MCU'", keys("𝓤").includes("McU") && keys("𝓤").includes("MCU"), true);
eq("loadSymbols(missing) -> []", loadSymbols("/no/such/file.json"), []);

// --- mergeSymbols ---
const base: Sym[] = [{ name: "to", glyph: "→" }, { name: "pi", glyph: "π" }];
eq("user entry overrides built-in by name",
  mergeSymbols(base, [{ name: "to", glyph: "⟶" }]).find((s) => s.name === "to")?.glyph, "⟶");
eq("new user entry appends",
  mergeSymbols(base, [{ name: "qed", glyph: "∎" }]).map((s) => s.name), ["to", "pi", "qed"]);
eq("invalid user entries skipped",
  mergeSymbols(base, [{ name: "", glyph: "x" } as Sym, { name: "ok", glyph: "" } as Sym]).length, 2);
// Duplicate names in the base must survive merge (e.g. \T -> ◁ and ▷).
const dup: Sym[] = [{ name: "T", glyph: "◁" }, { name: "T", glyph: "▷" }];
eq("duplicate base names preserved when not overridden",
  mergeSymbols(dup, []).map((s) => s.glyph), ["◁", "▷"]);
eq("user override replaces ALL same-named built-ins",
  mergeSymbols(dup, [{ name: "T", glyph: "⊤" }]).map((s) => s.glyph), ["⊤"]);

// --- orderByRecents ---
const list: Sym[] = [{ name: "a", glyph: "α" }, { name: "b", glyph: "β" }, { name: "c", glyph: "γ" }];
const ord = orderByRecents(list, ["c", "a"]);
eq("recents float to front in MRU order", ord.ordered.map((s) => s.name), ["c", "a", "b"]);
eq("recentCount counts matched recents", ord.recentCount, 2);
eq("unknown recents ignored", orderByRecents(list, ["zzz"]).recentCount, 0);
// Must not collapse duplicate names (the bundled table relies on this).
const dupList: Sym[] = [{ name: "T", glyph: "◁" }, { name: "x", glyph: "×" }, { name: "T", glyph: "▷" }];
eq("orderByRecents preserves duplicate names", orderByRecents(dupList, []).ordered.length, 3);
eq("full bundled table survives ordering", orderByRecents(syms, ["to"]).ordered.length, syms.length);

// --- Recents (MRU cap, dedup) ---
async function recentsTest() {
  const store: Record<string, unknown> = {};
  const memento: MementoLike = {
    get: <T>(k: string) => store[k] as T | undefined,
    update: async (k, v) => { store[k] = v; },
  };
  const r = new Recents(memento);
  await r.push("a"); await r.push("b"); await r.push("a"); // a moves to front, dedup
  eq("recents MRU + dedup", r.list(), ["a", "b"]);
  for (let i = 0; i < 15; i++) await r.push("s" + i);
  eq("recents capped at 10", new Recents(memento).list().length, 10);
}

await recentsTest();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall unicode tests passed");
