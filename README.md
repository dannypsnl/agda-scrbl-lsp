# agda-scrbl

Interactive Agda development **directly on `.lagda.scrbl`** cards — without
forking Agda. An LSP server keeps a line-preserved `.agda` mirror in sync,
drives `agda --interaction-json` on it, and maps results back to the scrbl. The
mirror is line-preserved so every Agda position is identical in the scrbl
(identity mapping inside code blocks); case-split/refine/give are addressed by
goal **id**, so no position translation is needed.

## How it works

```
*.lagda.scrbl  ──scrblToMirror──▶  _tmp/mirror/*.agda  ──▶  agda --interaction-json
     ▲                                                                 │
     └──────────── WorkspaceEdit (case-split clauses, ...) ◀───────────┘
```

The mirror is plain Agda: every line outside `@agda|{ … }|` (prose and the
markers) becomes blank, code is kept verbatim at its original line.

The project root is the nearest ancestor with a `*.agda-lib`; the mirror module
resolves with that project's normal libraries/flags.

## Use in any Agda project

This is a standalone extension — not tied to a specific repo. To use it in
project `P`:

1. `P` has a `*.agda-lib`. Add `_tmp/mirror` to its `include:` line, e.g.
   `include: src _tmp/mirror`, and git-ignore `_tmp/`.
2. Build & install this extension (below).
3. Open any `P/**/*.lagda.scrbl`. Mirrors are written to `P/_tmp/mirror/`.

## Build

```sh
npm install
npm run compile        # tsc -> out/
```

## Run in VSCode

Open this folder in VSCode and press **F5** (Extension Development Host), or
package with `vsce package` and install the `.vsix`. Then open any
`src/*.lagda.scrbl`:

- diagnostics (errors + `?n : type` goals) appear inline on save/edit
- hover a goal line to see its type
- `Ctrl-C Ctrl-L` — load/reload
- `Ctrl-C Ctrl-C` — case split (prompts for the variable)
- `Ctrl-C Ctrl-Space` — give (fills a `{! term !}` hole)
- `Ctrl-C Ctrl-R` — refine (`{! f !}` → `f ?`, intro on empty holes)
- `\` — unicode input: pops a picker, type an abbrev (`to`, `lambda`, `bN`) and
  accept to insert the glyph (`→`, `λ`, `ℕ`). Recently used glyphs float to the
  top; type a lone `\` to insert a literal backslash. Extend the table with the
  `agda-scrbl.unicodeInput.userSymbols` setting (`{ name, glyph, aliases? }`).

  The bundled table is the **complete Agda input table** (2300+ symbols),
  generated from `agda-mode`'s data — so you can uninstall the `agda-mode`
  extension and rely on this picker alone. (`agda-mode`'s `\` input method also
  grabs `.lagda.scrbl` files, because its keybinding matches any language id
  containing `agda`/`lagda`; uninstalling it removes that overlap.) Regenerate
  with `bun run scripts/gen-unicode-symbols.ts <path/to/agda-mode/asset/query.js>`.

`?` and `{! !}` are both recognised as goals. The edits land in the
`.lagda.scrbl` itself.

## Headless test

```sh
bun run test.ts        # drives real agda: load -> goals -> case-split
```

## Status

Working: mirror sync, status bar, load → diagnostics (goals + errors with
correct ranges), hover goal type, and goal actions applied back to the scrbl —
case-split (`Function` variant), give, refine. Both `?` and `{! !}` holes.

Not yet wired (same `executeCommand` plumbing):
- auto / goal-type-context panel
- `ExtendedLambda` case-split falls back to whole-line replace
- one `agda` process per open document (no cross-document interleaving guard)
