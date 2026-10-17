// Exports the landing primitive scenes to standalone SVG files and writes the
// README primitives table from the same landing data.
// Run `node docs/scripts/primitive-svgs.mjs` after you change a scene or a primitive.
// `--check` fails when the committed files are out of date.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { landingPrimitives } from "../app/components/landing/content.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const componentPath = join(repoRoot, "docs/app/components/landing/PrimitiveMotion.vue");
const readmePath = join(repoRoot, "README.md");

export const svgDirectory = ".github/assets/primitives";
const tableStart = "<!-- primitives:start -->";
const tableEnd = "<!-- primitives:end -->";
const columns = 3;

// GitHub's muted text and page background, so the scenes match the README in both themes.
const themeCss = `svg { color: #59636e; --ui-bg: #ffffff; }
@media (prefers-color-scheme: dark) { svg { color: #9198a1; --ui-bg: #0d1117; } }`;

function sceneBodies(template) {
  const scenes = new Map();
  const pattern = /^ {4}<template v-(?:else-)?if="name === '([a-z-]+)'">\n([\s\S]*?)^ {4}<\/template>$/gm;
  for (const [, name, body] of template.matchAll(pattern)) scenes.set(name, body);
  return scenes;
}

// The KV scene repeats its rows with `v-for="row in N"`. Expand it to static elements.
function expandLoops(body) {
  return body.replace(
    /^( *)<template v-for="(\w+) in (\d+)" :key="\w+">\n([\s\S]*?)^\1<\/template>\n/gm,
    (_, _indent, variable, count, inner) => {
      let output = "";
      for (let value = 1; value <= Number(count); value++) {
        output += inner.replace(/ :([a-z-]+)="([^"]+)"/g, (_match, attribute, expression) => {
          const result = runInNewContext(expression, { [variable]: value });
          return ` ${attribute}="${result}"`;
        });
      }
      return output;
    },
  );
}

function staticScene(name, body) {
  const output = expandLoops(body)
    .replace(/<!--[\s\S]*?-->\n?/g, "")
    .replace(/ :([a-z-]+)="`([^`"]*)`"/g, (_, attribute, value) =>
      ` ${attribute}="${value.replaceAll("${id}", `vh-${name}`)}"`);

  const binding = output.match(/ (?::|v-|@)[a-z-]+="/);
  if (binding) throw new Error(`The ${name} scene still has the Vue binding ${binding[0].trim()}`);
  return output;
}

// Splits the stylesheet into its top-level rules, at-rules included.
function topLevelRules(css) {
  const rules = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] !== "}" || --depth !== 0) continue;
    rules.push(css.slice(start, index + 1).trim());
    start = index + 1;
  }
  return rules;
}

// Keeps the rules whose selectors match the scene, and the keyframes that those rules name.
// The scenes only use class selectors, so a selector matches when the scene has all of its classes.
function sceneCss(css, scene) {
  const classes = new Set(["primitive-motion", "is-playing"]);
  for (const [, value] of scene.matchAll(/ class="([^"]+)"/g)) {
    for (const name of value.split(" ")) classes.add(name);
  }

  const rules = topLevelRules(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  const kept = rules.filter((rule) => {
    const prelude = rule.slice(0, rule.indexOf("{"));
    if (prelude.startsWith("@keyframes")) return false;
    if (prelude.startsWith("@")) return true;
    return prelude.split(",").some((selector) =>
      [...selector.matchAll(/\.([\w-]+)/g)].every(([, name]) => classes.has(name)));
  });
  const used = kept.join("\n");
  const keyframes = rules.filter((rule) => {
    const name = rule.match(/^@keyframes ([\w-]+)/)?.[1];
    return name !== undefined && used.includes(`animation-name: ${name};`);
  });
  return [...kept, ...keyframes].join("\n");
}

function sceneCycles(source) {
  const block = source.match(/const cycles: Record<string, number> = \{\n([\s\S]*?)\n\};/);
  if (!block) throw new Error("PrimitiveMotion.vue has no cycles table");
  const cycles = new Map();
  for (const [, name, value] of block[1].matchAll(/^ {2}"?([a-z-]+)"?: (\d+),$/gm)) {
    cycles.set(name, Number(value));
  }
  return cycles;
}

/** Returns the SVG file contents for each primitive, keyed by repository path. */
export async function renderPrimitiveSvgs() {
  const source = await readFile(componentPath, "utf8");
  const template = source.slice(source.indexOf("<template>"), source.indexOf("<style scoped>"));
  const css = source.slice(source.indexOf("<style scoped>") + "<style scoped>".length, source.lastIndexOf("</style>"));
  const scenes = sceneBodies(template);
  const cycles = sceneCycles(source);
  const files = new Map();

  landingPrimitives.forEach((primitive, index) => {
    const body = scenes.get(primitive.id);
    if (!body) throw new Error(`PrimitiveMotion.vue has no scene for ${primitive.id}`);
    const cycle = cycles.get(primitive.id) ?? 5000;
    // Same offset as the landing grid, so neighboring scenes do not move in step.
    const delay = Math.round(-((index * 0.37) % 1) * cycle);
    const scene = staticScene(primitive.id, body).trimEnd();
    files.set(
      `${svgDirectory}/${primitive.id}.svg`,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 0 58 40" width="58" height="40" preserveAspectRatio="xMinYMid meet" class="primitive-motion is-playing" style="--cycle: ${cycle}ms; --scene-delay: ${delay}ms">
<style>
${themeCss}
${sceneCss(css, scene)}
</style>
${scene}
</svg>
`,
    );
  });

  return files;
}

/** Returns the README table of primitives, between its start and end markers. */
export function renderPrimitivesTable() {
  const cells = landingPrimitives.map((primitive) =>
    `    <td width="33%" valign="top"><a href="https://vitehub.dev${primitive.to}"><img src="${svgDirectory}/${primitive.id}.svg" alt="" height="40"><br><b>${primitive.name}</b></a><br>${primitive.description}</td>`);
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
