import { Validator } from "@cfworker/json-schema";
import type { Schema } from "@cfworker/json-schema";
import { invariantError } from "@vite-hub/internal/invariant";
import registryItemSchema from "./schema/registry-item.json" with { type: "json" };
import registrySchema from "./schema/registry.json" with { type: "json" };

interface RegistryFile {
  path: string;
  type: string;
  target?: string;
  content?: string;
}

interface CssVars {
  theme: Record<string, string>;
  light: Record<string, string>;
  dark: Record<string, string>;
}

export interface RegistryItem {
  name: string;
  type: string;
  dependencies?: string[];
  registryDependencies?: string[];
  files?: RegistryFile[];
  cssVars?: Partial<CssVars>;
  [key: string]: unknown;
}

export interface Registry {
  name: string;
  homepage: string;
  items: RegistryItem[];
}

/** What the builder reads. Every path is relative to `packages/ui/`. */
export interface RegistrySource {
  read: (path: string) => string;
  /** The file names in a directory, without subdirectories. */
  list: (directory: string) => string[];
}

const itemSchema = "https://shadcn-vue.com/schema/registry-item.json";
const registryValidator = new Validator(registrySchema as Schema, "7", false);
registryValidator.addSchema(registryItemSchema as Schema, "https://ui.shadcn.com/schema/registry-item.json");

function isRegistry(value: unknown): value is Registry {
  return registryValidator.validate(value).valid;
}

/** The registry scope. An item's files import another item as `../<name>`, which becomes `@vitehub/<name>`. */
export const scope = "@vitehub";
/** shadcn-vue writes a component file without a target under the components alias, after the `components/` segment. */
const componentRoot = "components/vitehub";
/** Packages that every Vue app has, so an item does not list them. */
const implicitPackages = new Set(["vue"]);

const themeTokens = new Set(["font-sans", "font-mono"]);

function declarations(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)].map(([, name = "", value = ""]) => [name, value.trim()]));
}

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw invariantError(`tokens.css has no ${selector} block.`);
  return css.slice(start, css.indexOf("\n}", start));
}

export function tokensToCssVars(css: string): CssVars {
  const root = declarations(block(css, ":root"));
  const dark = declarations(block(css, ':is(.dark, [data-theme="dark"])'));
  const pick = (vars: Record<string, string>, inTheme: boolean) =>
    Object.fromEntries(Object.entries(vars).filter(([name]) => themeTokens.has(name) === inTheme));
  return { theme: pick(root, true), light: pick(root, false), dark: pick(dark, false) };
}

/** The module specifiers of the `import` statements and CSS `@import` rules in a file. */
export function importsOf(content: string): string[] {
  const specifiers = [
    ...content.matchAll(/^\s*import\s+(?:type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm),
    ...content.matchAll(/^\s*@import\s+(?:url\()?["']([^"']+)["']/gm),
  ].map(([, specifier = ""]) => specifier);
  return [...new Set(specifiers)];
}

/** The registry items and npm packages that a set of files imports. */
export function dependenciesOf(item: string, contents: string[], versions: Record<string, string>): { registry: string[]; packages: string[] } {
  const registry = new Set<string>();
  const packages = new Set<string>();
  for (const specifier of contents.flatMap(importsOf)) {
    if (specifier.startsWith("./")) continue;
    if (specifier.startsWith("../")) {
      const name = /^\.\.\/([\w-]+)(?:\/|$)/.exec(specifier)?.[1];
      if (!name || name === item) throw invariantError(`The registry item "${item}" imports "${specifier}". Import another item as "../<name>".`);
      registry.add(`${scope}/${name}`);
      continue;
    }
    if (specifier.startsWith("/") || /^[a-z]+:/.test(specifier)) throw invariantError(`The registry item "${item}" imports "${specifier}". Import a package or another item.`);
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0] ?? specifier;
    if (implicitPackages.has(name)) continue;
    // ui-sdk is in beta and changes between releases, so an item pins the release that the npm package builds with.
    if (name.startsWith("@ui-sdk/")) {
      const version = versions[name];
      if (!version || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw invariantError(`The registry item "${item}" imports ${name}, which packages/ui/package.json does not pin to an exact version.`);
      packages.add(`${name}@${version}`);
    }
    else packages.add(name);
  }
  return { registry: [...registry].sort(), packages: [...packages].sort() };
}

function packageVersions(read: RegistrySource["read"]): Record<string, string> {
  const manifest: unknown = JSON.parse(read("package.json"));
  if (typeof manifest !== "object" || manifest === null) return {};
  const versions: Record<string, string> = {};
  for (const field of ["peerDependencies", "devDependencies", "dependencies"]) {
    const entries: unknown = Reflect.get(manifest, field);
    if (typeof entries !== "object" || entries === null) continue;
    for (const [name, version] of Object.entries(entries)) if (typeof version === "string") versions[name] = version;
  }
  return versions;
}

/**
 * Builds the `@vitehub` registry from `registry/registry.json`. An item without `files` publishes the files of
 * `registry/<name>/` to `components/vitehub/<name>/`. Its
 * `registryDependencies` and `dependencies` come from the imports of those files. The index carries no file content;
 * each `<name>.json` does.
 */
export function buildRegistry({ list, read }: RegistrySource): Record<string, string> {
  const registry: unknown = JSON.parse(read("registry/registry.json"));
  if (!isRegistry(registry)) throw invariantError("registry/registry.json does not match the shadcn-vue registry schema.");
  const versions = packageVersions(read);
  const tokens = read("../kit/src/styles/tokens.css");
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const out: Record<string, string> = {};
  const index: RegistryItem[] = [];
  for (const item of registry.items) {
    const directory = `registry/${item.name}/`;
    const names = item.files ? [] : list(directory).sort();
    const files: RegistryFile[] = item.files?.map((file) => ({ ...file, content: read(`registry/${file.path}`) }))
      ?? names.map((name) => ({ path: `${componentRoot}/${item.name}/${name}`, type: "registry:component", content: read(`${directory}${name}`) }));
    const derived = dependenciesOf(item.name, files.filter((file) => !file.target).map((file) => file.content ?? ""), versions);
    const registryDependencies = [...new Set([...(item.registryDependencies ?? []), ...derived.registry])];
    const dependencies = [...new Set([...(item.dependencies ?? []), ...derived.packages])];
    const built: RegistryItem = {
      ...item,
      ...(dependencies.length ? { dependencies } : {}),
      ...(registryDependencies.length ? { registryDependencies } : {}),
      ...(item.type === "registry:theme" ? { cssVars: tokensToCssVars(tokens) } : {}),
      ...(files.length ? { files } : {}),
    };
    out[`${item.name}.json`] = json({ $schema: itemSchema, ...built });
    index.push({ ...built, ...(built.files ? { files: built.files.map(({ content: _content, ...file }) => file) } : {}) });
  }
  out["registry.json"] = json({ ...registry, items: index });
  return out;
}
