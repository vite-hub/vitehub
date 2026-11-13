// The registry build as a pure function, so the test can compare its output with the committed files.

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
  cssVars?: CssVars;
  [key: string]: unknown;
}

export interface Registry {
  name: string;
  homepage: string;
  items: RegistryItem[];
}

const itemSchema = "https://shadcn-vue.com/schema/registry-item.json";
// Tailwind reads these from `@theme`. The rest of the tokens are plain variables on `:root` and `.dark`.
const themeTokens = new Set(["font-sans", "font-mono"]);

function declarations(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)].map(([, name = "", value = ""]) => [name, value.trim()]));
}

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`tokens.css has no ${selector} block.`);
  return css.slice(start, css.indexOf("\n}", start));
}

/** The tokens of `tokens.css` as shadcn `cssVars`: names without `--`, fonts in `theme`. */
export function tokensToCssVars(css: string): CssVars {
  const root = declarations(block(css, ":root"));
  const dark = declarations(block(css, ':is(.dark, [data-theme="dark"])'));
  const pick = (vars: Record<string, string>, inTheme: boolean) =>
    Object.fromEntries(Object.entries(vars).filter(([name]) => themeTokens.has(name) === inTheme));
  return { theme: pick(root, true), light: pick(root, false), dark: pick(dark, false) };
}

/** Every file to write to `docs/public/r/`: one `<name>.json` for each item, and `registry.json`. */
export function buildRegistry(read: (path: string) => string): Record<string, string> {
  const registry: Registry = JSON.parse(read("registry/registry.json"));
  const tokens = read("src/styles/tokens.css");
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const out: Record<string, string> = {};
  for (const item of registry.items) {
    const built: RegistryItem = {
      $schema: itemSchema,
      ...item,
      ...(item.type === "registry:style" ? { cssVars: tokensToCssVars(tokens) } : {}),
      files: item.files?.map((file) => ({ ...file, content: read(file.path) })),
    };
    out[`${item.name}.json`] = json(built);
  }
  out["registry.json"] = json(registry);
  return out;
}
