import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js";

interface PackageManifest {
  dependencies: Record<string, string>;
  exports: Record<string, unknown>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
}

function parsePackageManifest(source: string): PackageManifest {
  const value: unknown = JSON.parse(source);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid @vite-hub/ui package manifest.");
  }
  const dependencies = stringRecord("dependencies" in value ? value.dependencies : undefined);
  const exports = unknownRecord("exports" in value ? value.exports : undefined);
  const peerDependencies = stringRecord(
    "peerDependencies" in value ? value.peerDependencies : undefined,
  );
  const peerDependenciesMeta = optionalPeerRecord(
    "peerDependenciesMeta" in value ? value.peerDependenciesMeta : undefined,
  );
  if (!dependencies || !exports || !peerDependencies || !peerDependenciesMeta) {
    throw new TypeError("Invalid @vite-hub/ui package manifest maps.");
  }
  return { dependencies, exports, peerDependencies, peerDependenciesMeta };
}

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  return { ...value };
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = unknownRecord(value);
  if (!record || Object.values(record).some((entry) => typeof entry !== "string")) return;
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, String(entry)]));
}

function optionalPeerRecord(value: unknown): Record<string, { optional?: boolean }> | undefined {
  const record = unknownRecord(value);
  if (!record) return;
  const entries: Array<[string, { optional?: boolean }]> = [];
  for (const [key, entry] of Object.entries(record)) {
    const metadata = unknownRecord(entry);
    if (!metadata || (metadata.optional !== undefined && typeof metadata.optional !== "boolean")) {
      return;
    }
    entries.push([key, metadata.optional === undefined ? {} : { optional: metadata.optional }]);
  }
  return Object.fromEntries(entries);
}

const packageJson = parsePackageManifest(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const stylesheet = readFileSync(new URL("../dist/styles.css", import.meta.url), "utf8");
const sourceStylesheet = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

// The root holds every component. An entry of its own is only for parts whose dependencies a chat page must not load, and
// for modules that load without the components: the theme, which apps import from nuxt.config, and the share links.
const publicEntries = [".", "./headless", "./markdown-editor", "./nuxt", "./playground", "./theme", "./vite", "./workspace"];

describe("@vite-hub/ui package contract", () => {
  it("exposes the documented entrypoints", () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual([...publicEntries, "./package.json", "./styles.css", "./theme.css"].sort());
    expect(packageJson.peerDependencies).toMatchObject({
      "@iconify-json/lucide": expect.any(String),
      "@nuxt/ui": expect.any(String),
      ai: expect.any(String),
      vite: expect.any(String),
      vue: expect.any(String),
    });
    expect(packageJson.peerDependenciesMeta).toEqual({
      "@iconify-json/lucide": { optional: true },
      "@nuxt/ui": { optional: true },
      // MarkdownEditor's Tiptap, only for apps that import @vite-hub/ui/markdown-editor.
      "@tiptap/core": { optional: true },
      "@tiptap/extension-image": { optional: true },
      "@tiptap/extension-list": { optional: true },
      "@tiptap/extension-table": { optional: true },
      "@tiptap/pm": { optional: true },
      "@tiptap/starter-kit": { optional: true },
      "@tiptap/vue-3": { optional: true },
      vite: { optional: true },
    });
    expect(packageJson.dependencies).toEqual({
      "@comark/vue": "0.9.0",
      "comark-chat": "catalog:",
      comark: "catalog:markdown-ui",
      "vega-loader": "^5.1.3",
      katex: "^0.19.1",
      "@nuxt/kit": "4.6.2",
      "@shikijs/langs": "4.5.0",
      "@shikijs/themes": "4.5.0",
      "@types/node": "catalog:tooling",
      "@vite-hub/comments": "workspace:*",
      "@vite-hub/kit": "workspace:*",
      "nostics": "catalog:runtime",
      shiki: "^4.5.0",
      "@codemirror/autocomplete": "6.20.4",
      "@codemirror/commands": "6.11.1",
      "@codemirror/lang-css": "6.3.1",
      "@codemirror/lang-html": "6.4.12",
      "@codemirror/lang-javascript": "6.2.5",
      "@codemirror/lang-json": "6.0.2",
      "@codemirror/lang-markdown": "6.5.2",
      "@codemirror/lang-vue": "0.1.3",
      "@codemirror/language": "6.13.1",
      "@codemirror/state": "6.7.6",
      "@codemirror/view": "6.43.15",
      "@lezer/highlight": "1.2.5",
      "@vite-hub/web-container": "workspace:*",
      "@xterm/addon-fit": "0.11.0",
      "@xterm/xterm": "6.0.0",
    });
  });

  // Each fresh Node process gets its own timeout and reports the failing entrypoint.
  it.each(publicEntries)("loads JavaScript entrypoint %s from the built package", async (entry) => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/ui", [entry]);
  });

  it("ships flat console surfaces that fill their containers", () => {
    for (const block of [".vh-chat", ".vh-session", ".vh-agent-session"]) {
      expect(stylesheet, block).toMatch(new RegExp(`\\n\\s*${block.replace(".", "\\.")}\\s*\\{[^}]*height: 100%;[^}]*min-height: 0;`));
    }
    // Folded text fades to signal more content; the surrounding surfaces stay flat.
    const surfaces = stylesheet.replace(/\.vh-agent-session__bubble\[data-folded\] \.vh-agent-session__bubble-text\s*\{[^}]*\}/g, "");
    expect(surfaces).not.toMatch(/backdrop-filter|mask-image|linear-gradient/);
    expect(stylesheet).not.toContain("--vh-ui-text-muted");
  });

  it("keeps AgentSession as a private component module", () => {
    expect(existsSync(new URL("../dist/parts/components/agent-session.js", import.meta.url))).toBe(true);
    expect(readFileSync(new URL("../dist/index.js", import.meta.url), "utf8")).toContain("./parts/components/agent-session.js");
  });

  it("keeps WebContainer, CodeMirror, and xterm out of the root barrel, and loads the editor and terminal on demand", () => {
    const dist = new URL("../dist/", import.meta.url);
    const read = (name: string) => readFileSync(new URL(name, dist), "utf8");
    const root = read("index.js");
    for (const name of ["@vite-hub/web-container", "@codemirror/", "@xterm/"]) expect(root, name).not.toContain(name);
    // The app runs the WebContainer with `useWebContainer()` of @vite-hub/web-container/vue, and the parts render its state.
    // Only PlaygroundContainer, the whole playground, runs it itself.
    const webContainerImporters = (readdirSync(dist, { recursive: true }) as string[])
      .filter((name) => name.endsWith(".js") && /from\s*"@vite-hub\/web-container(?:\/vue)?"/.test(read(name)));
    expect(webContainerImporters).toEqual(["parts/workspace/playground-container.js"]);
    expect(read("parts/workspace/workspace-editor.js")).not.toMatch(/from\s*"@codemirror\//);
    expect(read("parts/workspace/workspace-terminal.js")).not.toMatch(/from\s*"@xterm\//);
    expect(read("parts/workspace/workspace-terminal.js")).toMatch(/import\("@xterm\/xterm"\)/);
    expect(read("parts/workspace/playground-container.js")).not.toMatch(/from\s*"@(?:codemirror|xterm)\//);
  });

  it("loads Shiki for PlaygroundRender only after its first render", () => {
    const dist = new URL("../dist/", import.meta.url);
    const read = (name: string) => readFileSync(new URL(name, dist), "utf8");
    expect(read("index.js")).not.toMatch(/from\s*"shiki/);
    const part = read("parts/playground/playground-render.js");
    expect(part).not.toMatch(/from\s*"shiki/);
    const chunk = part.match(/import\("\.\/(highlight[^"]*\.js)"\)/)?.[1];
    expect(chunk).toBeDefined();
    expect(read(`parts/playground/${chunk}`)).toMatch(/from\s*"shiki\/core"/);
  });

  it("keeps Tiptap out of the root barrel and its own dependency", () => {
    const dist = new URL("../dist/", import.meta.url);
    expect(readFileSync(new URL("index.js", dist), "utf8")).not.toContain("@tiptap/");
    // Bundled Tiptap would be a second copy beside the one Nuxt UI's editor menus use.
    const editor = readdirSync(dist).find((name) => /^markdown-editor-[^/]+\.js$/.test(name));
    expect(editor && readFileSync(new URL(editor, dist), "utf8")).toMatch(/from\s*"@tiptap\/vue-3"/);
  });

  it("keeps KaTeX out of the global stylesheet", () => {
    expect(sourceStylesheet).not.toContain("katex");
    expect(stylesheet).not.toContain("KaTeX_Main");
  });

  it("keeps the Pierre renderer behind an on-demand chunk", () => {
    const dist = new URL("../dist/", import.meta.url);
    const sources = ["index.js", ...readdirSync(dist).filter((name) => /^code-view-[^/]+\.js$/.test(name))]
      .map((name) => readFileSync(new URL(name, dist), "utf8"));
    const rendererImport = sources
      .map((source) => source.match(/import\("\.\/(pierre-code-view-[^"]+\.js)"\)/)?.[1])
      .find((name): name is string => name !== undefined);

    expect(rendererImport).toBeDefined();
    expect(existsSync(new URL(rendererImport!, dist))).toBe(true);
  });
});
