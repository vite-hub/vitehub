import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildRegistry } from "./registry.ts";

const ui = fileURLToPath(new URL("../", import.meta.url));
const out = fileURLToPath(new URL("../../../docs/public/r/", import.meta.url));

const files = buildRegistry({
  list: (directory) => existsSync(`${ui}${directory}`) ? readdirSync(`${ui}${directory}`, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name) : [],
  read: (path) => readFileSync(`${ui}${path}`, "utf8"),
});
rmSync(out, { force: true, recursive: true });
mkdirSync(out, { recursive: true });
for (const [name, content] of Object.entries(files)) writeFileSync(`${out}${name}`, content);
