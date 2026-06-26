// scrbl -> line-preserved .agda mirror.
// Everything outside @agda|{ … }| (prose + the markers) becomes a blank line.
// Inside a block the code is kept on its original line, but the block's common
// leading whitespace is stripped: when @agda|{ } is nested inside @tr/card{ },
// the code is syntactically indented, yet that indent is layout-only (like HTML)
// — Agda's column 0 is the block's own left edge. So a top-level decl must land
// at column 0 regardless of how deep the card nests it.
//
// Line count is preserved (position translation is the identity on lines), but
// columns shift left by the stripped indent. `Mirror.indents[i]` records how
// many chars were stripped from output line i, so a consumer can recover scrbl
// columns: scrblCol = agdaCol + indents[line].

export const OPEN = "@agda|{";
export const CLOSE = "}|";

export interface Mirror {
  text: string;
  /** Per output-line (0-based): leading chars stripped from that line's @agda
   *  block. 0 for prose / marker / blank lines. Add to an Agda-reported column
   *  to get the scrbl column. */
  indents: number[];
}

function leadingWs(line: string): number {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

/** Min indent over a block's non-blank lines; 0 if all blank. */
function blockMinIndent(lines: string[]): number {
  let m: number | null = null;
  for (const l of lines) {
    if (l.trim() === "") continue;
    const n = leadingWs(l);
    if (m === null || n < m) m = n;
  }
  return m ?? 0;
}

/** scrbl text -> dedented, line-preserved mirror plus per-line indent map. */
export function mirror(text: string): Mirror {
  const lines = text.split("\n");
  const out: string[] = [];
  const indents: number[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === OPEN) {
      out.push(""); indents.push(0);                 // open marker -> blank
      i++;
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() !== CLOSE) body.push(lines[i++]);
      const m = blockMinIndent(body);
      for (const l of body) {
        out.push(l.slice(Math.min(m, l.length)));
        indents.push(m);
      }
      if (i < lines.length) { out.push(""); indents.push(0); i++; }  // close -> blank
    } else {
      out.push(""); indents.push(0); i++;
    }
  }
  return { text: out.join("\n"), indents };
}

/** Back-compat: just the mirror text. */
export function scrblToMirror(text: string): string {
  return mirror(text).text;
}

/** Leading whitespace of a line, for re-indenting case-split clauses. */
export function indentOf(line: string): string {
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : "";
}
