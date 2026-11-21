// Builds the `@vitehub` shadcn-vue registry into `docs/public/r/`, which vitehub.dev serves at `/r/<name>.json`.
// It reads `registry.json`, inlines each file's content, and gives every `registry:style` item the tokens of
// `src/styles/tokens.css` as `cssVars`, so the tokens have one source.
//
// Run: pnpm --filter @vite-hub/kit build:registry
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildRegistry } from "./registry.ts";

const kit = fileURLToPath(new URL("../", import.meta.url));
const out = fileURLToPath(new URL("../../../docs/public/r/", import.meta.url));

const files = buildRegistry((path) => readFileSync(`${kit}${path}`, "utf8"));
rmSync(out, { force: true, recursive: true });
mkdirSync(out, { recursive: true });
for (const [name, content] of Object.entries(files)) writeFileSync(`${out}${name}`, content);
