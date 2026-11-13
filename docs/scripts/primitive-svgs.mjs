// Exports the ViteHub icon of each landing primitive to a standalone SVG file and writes the
// README primitives table from the same landing data, so the README shows the icons of the docs and the Console.
// Run `node docs/scripts/primitive-svgs.mjs` after you change an icon or a primitive.
// `--check` fails when the committed files are out of date.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { landingPrimitives } from "../app/components/landing/content.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const iconDirectory = join(repoRoot, "packages/icons/svg");
const readmePath = join(repoRoot, "README.md");

export const svgDirectory = ".github/assets/primitives";
const tableStart = "<!-- primitives:start -->";
const tableEnd = "<!-- primitives:end -->";
const columns = 4;

// GitHub's muted text, so the icons match the README in both themes.
const themeStyle = `<style>
svg { color: #59636e; }
@media (prefers-color-scheme: dark) { svg { color: #9198a1; } }
</style>`;

/** Returns the SVG file contents for each primitive, keyed by repository path. */
export async function renderPrimitiveSvgs() {
  const files = new Map();
  for (const primitive of landingPrimitives) {
    const name = primitive.icon.replace(/^i-vitehub-/, "");
    if (name === primitive.icon) throw new Error(`${primitive.id} needs an i-vitehub-* icon, not ${primitive.icon}`);
    const source = await readFile(join(iconDirectory, `${name}.svg`), "utf8");
    files.set(
      `${svgDirectory}/${primitive.id}.svg`,
      source.replace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"`).replace(/>\n/, `>\n${themeStyle}\n`),
    );
  }
  return files;
}

/** Returns the README table of primitives, between its start and end markers. */
export function renderPrimitivesTable() {
  const cells = landingPrimitives.map((primitive) =>
    `    <td width="${100 / columns}%" valign="top"><a href="https://vitehub.dev${primitive.to}"><img src="${svgDirectory}/${primitive.id}.svg" alt="" height="24"><br><b>${primitive.name}</b></a><br>${primitive.description}</td>`);
  const rows = [];
  for (let index = 0; index < cells.length; index += columns) {
    rows.push(`  <tr>\n${cells.slice(index, index + columns).join("\n")}\n  </tr>`);
  }
  return `${tableStart}\n<table>\n${rows.join("\n")}\n</table>\n${tableEnd}`;
}

export function replacePrimitivesTable(readme) {
  const start = readme.indexOf(tableStart);
  const end = readme.indexOf(tableEnd);
  if (start === -1 || end === -1) throw new Error(`README.md needs the ${tableStart} and ${tableEnd} markers`);
  return readme.slice(0, start) + renderPrimitivesTable() + readme.slice(end + tableEnd.length);
}

async function main() {
  const check = process.argv.includes("--check");
  const files = await renderPrimitiveSvgs();
  const readme = await readFile(readmePath, "utf8");
  files.set("README.md", replacePrimitivesTable(readme));

  const stale = [];
  for (const [path, contents] of files) {
    const current = await readFile(join(repoRoot, path), "utf8").catch(() => undefined);
    if (current === contents) continue;
    stale.push(path);
    if (check) continue;
    await mkdir(dirname(join(repoRoot, path)), { recursive: true });
    await writeFile(join(repoRoot, path), contents);
  }

  if (check && stale.length > 0) {
    console.error(`Out of date: ${stale.join(", ")}. Run node docs/scripts/primitive-svgs.mjs`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
