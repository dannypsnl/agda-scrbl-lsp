// Structured unicode table: { name, glyph, aliases? }. The bundled table lives
// in resources/unicode-symbols.json; user entries from settings are merged over
// it by name. Modelled on vscode-violet's unicode input.
import * as fs from "fs";

export interface Symbol {
  name: string;
  glyph: string;
  aliases?: string[];
}

function readAliases(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((a) => typeof a === "string")
    ? (value as string[])
    : undefined;
}

// Parse + validate a JSON symbol table. Returns [] on any read/parse error or a
// non-array payload, so a broken table degrades to an empty picker rather than
// throwing on activation.
export function loadSymbols(jsonPath: string): Symbol[] {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Symbol[] = [];
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { name: unknown }).name === "string" &&
      typeof (entry as { glyph: unknown }).glyph === "string"
    ) {
      const e = entry as { name: string; glyph: string; aliases?: unknown };
      const aliases = readAliases(e.aliases);
      out.push({ name: e.name, glyph: e.glyph, ...(aliases ? { aliases } : {}) });
    }
  }
  return out;
}

// Merge user-defined entries over the built-ins. The bundled table (the full
// Agda input table) has many duplicate names — e.g. `T` produces both ◁ and ▷,
// `st` produces dozens of stars — so we must NOT key the base by name or we'd
// drop those alternatives. Instead: keep every built-in, but if a user entry
// shares a name with built-ins, those built-ins are removed and the user's
// entries take their place (appended). Invalid user entries are skipped.
export function mergeSymbols(base: Symbol[], user: Symbol[]): Symbol[] {
  const valid: Symbol[] = [];
  for (const entry of user) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.name !== "string" || entry.name.length === 0) continue;
    if (typeof entry.glyph !== "string" || entry.glyph.length === 0) continue;
    const aliases = readAliases(entry.aliases);
    valid.push({ name: entry.name, glyph: entry.glyph, ...(aliases ? { aliases } : {}) });
  }
  const overridden = new Set(valid.map((s) => s.name));
  const kept = base.filter((s) => !overridden.has(s.name));
  return [...kept, ...valid];
}
