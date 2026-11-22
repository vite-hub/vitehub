import { readdirSync, readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import type { Schema } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";

import { buildRegistry, tokensToCssVars } from "../registry/registry.ts";
import type { RegistryItem } from "../registry/registry.ts";

const kit = new URL("../", import.meta.url);
const published = new URL("../../../docs/public/r/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, kit), "utf8");
const schema = (name: string): Schema => JSON.parse(read(`registry/schema/${name}`));

const built = buildRegistry(read);
const items: RegistryItem[] = Object.entries(built)
  .filter(([name]) => name !== "registry.json")
  .map(([, content]) => JSON.parse(content));

describe("@vitehub registry", () => {
  it("validates every item against the shadcn-vue item schema", () => {
    const validator = new Validator(schema("registry-item.json"), "7", false);
    for (const item of items) {
      const result = validator.validate(item);
      expect(result.errors, item.name).toEqual([]);
    }
  });

  it("validates the index against the shadcn-vue registry schema", () => {
    const validator = new Validator(schema("registry.json"), "7", false);
    validator.addSchema(schema("registry-item.json"), "https://ui.shadcn.com/schema/registry-item.json");
    expect(validator.validate(JSON.parse(built["registry.json"] ?? "")).errors).toEqual([]);
  });

  it("references only @vitehub items and URLs, and never Reka UI", () => {
    for (const item of items) {
      for (const dependency of item.registryDependencies ?? []) {
        expect(dependency, item.name).toMatch(/^(?:@vitehub\/|https:\/\/)/);
      }
      const packages = [item.dependencies, item.devDependencies].flat().filter((name) => typeof name === "string");
      expect(packages, item.name).not.toContainEqual(expect.stringMatching(/^reka-ui(?:@|$)/));
    }
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
    expect(items.find((item) => item.type === "registry:style")?.cssVars).toEqual(tokensToCssVars(read("src/styles/tokens.css")));
  });

  it("rejects an invalid registry item before reading its files", () => {
    expect(() => buildRegistry((path) => {
      expect(path).toBe("registry/registry.json");
      return JSON.stringify({ name: "vitehub", homepage: "https://vitehub.dev", items: [{ name: "invalid", type: "registry:file", files: [{ type: "registry:file" }] }] });
    })).toThrow("registry/registry.json does not match the shadcn-vue registry schema.");
  });

  it("declares the CSS package shadcn-vue imports when adding the skill after the style", () => {
    const skill = items.find((item) => item.name === "vitehub-ui-skill");
    expect(skill?.dependencies ?? []).toContain("tw-animate-css");
  });
});
