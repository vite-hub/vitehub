import { readdirSync, readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import type { Schema } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";

import { buildRegistry } from "../registry/registry.ts";
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
    // The registry schema points its items at the shadcn URL of the same item schema.
    validator.addSchema(schema("registry-item.json"), "https://ui.shadcn.com/schema/registry-item.json");
    expect(validator.validate(JSON.parse(built["registry.json"] ?? "")).errors).toEqual([]);
  });

  it("references only @vitehub items and URLs, and never Reka UI", () => {
    // A stock shadcn-vue item such as `button` or `utils` installs reka-ui.
    for (const item of items) {
      for (const dependency of item.registryDependencies ?? []) {
        expect(dependency, item.name).toMatch(/^(?:@vitehub\/|https:\/\/)/);
      }
      const packages = [item.dependencies, item.devDependencies].flat().filter((name) => typeof name === "string");
      expect(packages, item.name).not.toContainEqual(expect.stringMatching(/^reka-ui(?:@|$)/));
    }
  });

  it("matches the files in docs/public/r", () => {
    // Run `pnpm --filter @vite-hub/kit build:registry` after a change to the registry, the tokens, or the family.
    const files = Object.fromEntries(readdirSync(published).map((name) => [name, readFileSync(new URL(name, published), "utf8")]));
    expect(files).toEqual(built);
  });

  it("gives the style the tokens of tokens.css", () => {
    const style = items.find((item) => item.type === "registry:style");
    expect(style?.cssVars?.light).toMatchObject({ background: "oklch(1 0 0)", radius: "0.25rem", ring: "oklch(0.588 0.158 241.966)" });
    expect(style?.cssVars?.dark).toMatchObject({ background: "oklch(0 0 0)", foreground: "oklch(0.985 0 0)" });
    expect(Object.keys(style?.cssVars?.theme ?? {})).toEqual(["font-sans", "font-mono"]);
  });
});
