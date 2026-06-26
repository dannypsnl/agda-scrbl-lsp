# agda-scrbl

Interactive Agda development **directly on `.lagda.scrbl`** cards — without
forking Agda. An LSP server keeps a line-preserved `.lagda.md` mirror in sync,
drives `agda --interaction-json` on it, and maps results back to the scrbl. The
mirror is line-preserved so every Agda position is identical in the scrbl
(identity mapping inside code blocks); case-split/refine/give are addressed by
goal **id**, so no position translation is needed.

## How it works

```
.lagda.scrbl  ──scrblToMirror──▶  _tmp/mirror/<card>.agda  ──▶  agda --interaction-json
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

## Releasing

CI (`.github/workflows/ci.yml`) type-checks and builds a `.vsix` on every push
and PR to `main`.

Publishing is tag-driven (`.github/workflows/release.yml`):

```sh
# bump "version" in package.json first, commit, then:
git tag v0.0.2
git push origin v0.0.2
```

The tag (minus the leading `v`) must match `package.json`'s `version`. On a
matching tag the workflow packages the `.vsix`, attaches it to a GitHub Release,
and publishes to the VS Code Marketplace.

One-time setup: add a `VSCE_PAT` repository secret — a [Marketplace personal
access token](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token)
for the `dannypsnl` publisher.

## License

[MIT](./LICENSE) © Lîm Tsú-thuàn
