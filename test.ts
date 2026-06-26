// Headless smoke test: drive real `agda --interaction-json` through the
// mirror + Agda modules, no LSP/VSCode involved. Run with: bun run test.ts
import { scrblToMirror, indentOf } from "./src/mirror";
import { Agda } from "./src/agda";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const scrbl = `@title{t}

@agda|{
{-# OPTIONS --without-K #-}
module ag-zztest where

data Two : Set where
  t0 t1 : Two

f : Two → Two
f x = ?
}|
`;

const root = resolve(import.meta.dir, "../..");          // blog repo root
const mirror = resolve(root, "_tmp/mirror/ag-zztest.agda");
mkdirSync(dirname(mirror), { recursive: true });
writeFileSync(mirror, scrblToMirror(scrbl) + "\n");

const agda = new Agda(mirror, root, "agda", (s) => process.stderr.write("[agda] " + s));

const load = await agda.load();
console.log("GOALS  :", JSON.stringify(load.goals));
console.log("ERRORS :", JSON.stringify(load.errors));

const g = load.goals[0];
if (!g) { console.error("no goal found"); agda.dispose(); process.exit(1); }

const mc = await agda.makeCase(g.id, "x");
console.log("MAKECASE:", JSON.stringify(mc));

// apply Function-variant case split back into the scrbl (identity line mapping)
if (mc && mc.variant === "Function") {
  const lines = scrbl.split("\n");
  const target = mc.line - 1;                 // 1-based -> 0-based, == scrbl line
  const indent = indentOf(lines[target]);
  const replacement = mc.clauses.map((c) => indent + c);
  lines.splice(target, 1, ...replacement);
  console.log("\n=== scrbl after case split ===");
  console.log(lines.join("\n"));
}

agda.dispose();
