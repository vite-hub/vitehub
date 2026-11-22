import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildRegistry } from "./registry.ts";

const kit = fileURLToPath(new URL("../", import.meta.url));
const out = fileURLToPath(new URL("../../../docs/public/r/", import.meta.url));

const files = buildRegistry((path) => readFileSync(`${kit}${path}`, "utf8"));
rmSync(out, { force: true, recursive: true });
mkdirSync(out, { recursive: true });
for (const [name, content] of Object.entries(files)) writeFileSync(`${out}${name}`, content);
