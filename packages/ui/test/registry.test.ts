import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import type { Schema } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";

import { buildRegistry, dependenciesOf, importsOf, tokensToCssVars } from "../registry/registry.ts";
import type { RegistryItem, RegistrySource } from "../registry/registry.ts";

const ui = new URL("../", import.meta.url);
const published = new URL("../../../docs/public/r/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ui), "utf8");
const list = (directory: string) => {
  const url = new URL(directory, ui);
  return existsSync(url) ? readdirSync(url, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name) : [];
};
const source: RegistrySource = { list, read };
const schema = (name: string): Schema => JSON.parse(read(`registry/schema/${name}`));

const built = buildRegistry(source);
const items: RegistryItem[] = Object.entries(built)
  .filter(([name]) => name !== "registry.json")
  .map(([, content]) => JSON.parse(content));
const index: { items: RegistryItem[] } = JSON.parse(built["registry.json"] ?? "");
const item = (name: string) => items.find((entry) => entry.name === name);

describe("@vitehub registry", () => {
  it("validates every item against the shadcn-vue item schema", () => {
    const validator = new Validator(schema("registry-item.json"), "7", false);
    for (const entry of items) {
      const result = validator.validate(entry);
      expect(result.errors, entry.name).toEqual([]);
    }
  });

  it("validates the index against the shadcn-vue registry schema", () => {
    const validator = new Validator(schema("registry.json"), "7", false);
    validator.addSchema(schema("registry-item.json"), "https://ui.shadcn.com/schema/registry-item.json");
    expect(validator.validate(index).errors).toEqual([]);
  });

  it("keeps file content out of the index and in each item", () => {
    for (const entry of index.items) for (const file of entry.files ?? []) expect(file, entry.name).not.toHaveProperty("content");
    for (const entry of items) for (const file of entry.files ?? []) expect(file.content, `${entry.name} ${file.path}`).toEqual(expect.any(String));
  });

  it("references only @vitehub items, and never Reka UI", () => {
    for (const entry of items) {
      for (const dependency of entry.registryDependencies ?? []) expect(dependency, entry.name).toMatch(/^@vitehub\/[\w-]+$/);
      const packages = [entry.dependencies, entry.devDependencies].flat().filter((name) => typeof name === "string");
      expect(packages, entry.name).not.toContainEqual(expect.stringMatching(/^reka-ui(?:@|$)/));
      for (const file of entry.files ?? []) expect(file.content, `${entry.name} ${file.path}`).not.toMatch(/["']reka-ui["']/);
    }
  });

  it("installs each component file under components/vitehub/<item>/", () => {
    for (const entry of items.filter((candidate) => candidate.type !== "registry:item")) {
      for (const file of entry.files ?? []) {
        expect(file.path).toMatch(new RegExp(`^components/vitehub/${entry.name}/[\\w.-]+$`));
        expect(file).not.toHaveProperty("target");
      }
    }
  });

  it("derives the item and package dependencies from the imports", () => {
    expect(item("status")?.registryDependencies).toEqual(["@vitehub/core"]);
    expect(item("copy-button")?.registryDependencies).toEqual(["@vitehub/core"]);
    expect(item("copy-button")?.dependencies).toEqual(["@lucide/vue", "@ui-sdk/vue@0.1.0-beta.19"]);
    expect(item("core")?.dependencies).toEqual(["@ui-sdk/core@0.1.0-beta.19"]);
    expect(item("example-status")?.registryDependencies).toEqual(["@vitehub/status"]);
    expect(item("example-copy-button")?.registryDependencies).toEqual(["@vitehub/copy-button"]);
    expect(item("base")?.registryDependencies).toEqual(["@vitehub/theme", "@vitehub/core"]);
  });

  it("reads import statements and CSS imports, and pins ui-sdk to the npm package's release", () => {
    expect(importsOf(`<script setup lang="ts">
import "../core/vitehub.css";
import type { A } from "./types.ts";
import { Button } from "@ui-sdk/vue/button";
import { ref } from "vue";
</script>`)).toEqual(["../core/vitehub.css", "./types.ts", "@ui-sdk/vue/button", "vue"]);
    expect(importsOf(`@import "@ui-sdk/core/web.css";\n@import url("./local.css");`)).toEqual(["@ui-sdk/core/web.css", "./local.css"]);
    expect(dependenciesOf("a", ['import { B } from "../b/index.ts";\nimport x from "pkg/sub";\nimport "@scope/pkg/file.css";'], {})).toEqual({
      packages: ["@scope/pkg", "pkg"],
      registry: ["@vitehub/b"],
    });
    expect(dependenciesOf("a", ['import { Button } from "@ui-sdk/vue/button";'], { "@ui-sdk/vue": "1.2.3-beta.4" }).packages).toEqual(["@ui-sdk/vue@1.2.3-beta.4"]);
    expect(() => dependenciesOf("a", ['import { Button } from "@ui-sdk/vue/button";'], { "@ui-sdk/vue": "^1.2.3" })).toThrow("does not pin");
    expect(() => dependenciesOf("a", ['import x from "../../src/index.ts";'], {})).toThrow('Import another item as "../<name>".');
  });

  it("matches the files in docs/public/r", () => {
    const files = Object.fromEntries(readdirSync(published).map((name) => [name, readFileSync(new URL(name, published), "utf8")]));
    expect(files).toEqual(built);
  });

  it("puts fonts in theme and keeps light and dark tokens separate", () => {
    const css = `:root {
  --font-sans: sans-serif;
  --font-mono: monospace;
  --background: white;
}
:is(.dark, [data-theme="dark"]) {
  --background: black;
}`;
    expect(tokensToCssVars(css)).toEqual({
      theme: { "font-sans": "sans-serif", "font-mono": "monospace" },
      light: { background: "white" },
      dark: { background: "black" },
    });
    expect(item("theme")?.cssVars).toEqual(tokensToCssVars(read("../kit/src/styles/tokens.css")));
  });

  it("rejects an invalid registry item before reading its files", () => {
    expect(() => buildRegistry({
      list: () => [],
      read: (path) => {
        expect(path).toBe("registry/registry.json");
        return JSON.stringify({ name: "vitehub", homepage: "https://vitehub.dev", items: [{ name: "invalid", type: "registry:file", files: [{ type: "registry:file" }] }] });
      },
    })).toThrow("registry/registry.json does not match the shadcn-vue registry schema.");
  });

  it("gives the app's components layer a rule, so a hoisted empty layer statement cannot move it before base", () => {
    expect(item("core")?.css).toEqual({ "@layer components": { ":where([data-slot])": { "box-sizing": "border-box" } } });
  });

  it("declares the CSS package shadcn-vue imports when adding the skill after the style", () => {
    expect(item("vitehub-ui-skill")?.dependencies ?? []).toContain("tw-animate-css");
  });

  it("inlines every item stylesheet that styles.css imports, and the core stylesheet is not one of them", () => {
    const imports = [...read("styles.css").matchAll(/^@import "\.\/registry\/([\w-]+)\/[\w-]+\.css";$/gm)].map(([, name]) => name);
    expect(imports).toEqual(["status", "copy-button"]);
  });
});
