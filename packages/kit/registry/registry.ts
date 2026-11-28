import { Validator } from "@cfworker/json-schema";
import type { Schema } from "@cfworker/json-schema";
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

const itemSchema = "https://shadcn-vue.com/schema/registry-item.json";
const registryValidator = new Validator(registrySchema as Schema, "7", false);
registryValidator.addSchema(registryItemSchema as Schema, "https://ui.shadcn.com/schema/registry-item.json");

function isRegistry(value: unknown): value is Registry {
  return registryValidator.validate(value).valid;
}

const themeTokens = new Set(["font-sans", "font-mono"]);

function declarations(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)].map(([, name = "", value = ""]) => [name, value.trim()]));
}

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`tokens.css has no ${selector} block.`);
  return css.slice(start, css.indexOf("\n}", start));
}

export function tokensToCssVars(css: string): CssVars {
  const root = declarations(block(css, ":root"));
  const dark = declarations(block(css, ':is(.dark, [data-theme="dark"])'));
  const pick = (vars: Record<string, string>, inTheme: boolean) =>
    Object.fromEntries(Object.entries(vars).filter(([name]) => themeTokens.has(name) === inTheme));
  return { theme: pick(root, true), light: pick(root, false), dark: pick(dark, false) };
}

function withTokens(tokens: CssVars, own: Partial<CssVars> = {}): CssVars {
  return {
    theme: { ...tokens.theme, ...own.theme },
    light: { ...tokens.light, ...own.light },
    dark: { ...tokens.dark, ...own.dark },
  };
}

function pin(versions: Record<string, string>): (name: string) => string {
  return (name) => {
    const version = versions[name];
    return version && /^\d/.test(version) ? `${name}@${version}` : name;
  };
}

export function buildRegistry(read: (path: string) => string): Record<string, string> {
  const registry: unknown = JSON.parse(read("registry/registry.json"));
  if (!isRegistry(registry)) throw new Error("registry/registry.json does not match the shadcn-vue registry schema.");
  const tokens = tokensToCssVars(read("src/styles/tokens.css"));
  const kit: { dependencies?: Record<string, string> } = JSON.parse(read("package.json"));
  const version = pin(kit.dependencies ?? {});
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const out: Record<string, string> = {};
  for (const item of registry.items) {
    const dependencies = Array.isArray(item.dependencies) ? item.dependencies.filter((name) => typeof name === "string").map(version) : undefined;
    const built: RegistryItem = {
      $schema: itemSchema,
      ...item,
      ...(dependencies ? { dependencies } : {}),
      ...(item.type === "registry:style" || item.type === "registry:theme" ? { cssVars: withTokens(tokens, item.cssVars) } : {}),
      files: item.files?.map((file) => ({ ...file, path: file.path.replace(/^registry\//, ""), content: read(file.path) })),
    };
    out[`${item.name}.json`] = json(built);
  }
  out["registry.json"] = json(registry);
  return out;
}
