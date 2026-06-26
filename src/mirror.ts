// scrbl -> line-preserved .agda mirror.
// Everything outside @agda|{ … }| (prose + the markers) becomes a blank line;
// the code is kept verbatim at its original line. So the mirror is plain Agda
// source whose line:col matches the .lagda.scrbl 1:1 — position translation is
// the identity inside code regions.

export const OPEN = "@agda|{";
export const CLOSE = "}|";

/** scrbl text -> mirror (.agda) text, line count preserved. */
export function scrblToMirror(text: string): string {
  let inCode = false;
  return text.split("\n").map((line) => {
    const t = line.trim();
    if (!inCode && t === OPEN) { inCode = true; return ""; }
    if (inCode && t === CLOSE) { inCode = false; return ""; }
    return inCode ? line : "";
  }).join("\n");
}

/** Leading whitespace of a line, for re-indenting case-split clauses. */
export function indentOf(line: string): string {
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : "";
}
