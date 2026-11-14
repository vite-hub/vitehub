import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNuxt } from "nuxt";
import { afterEach, describe, expect, it } from "vitest";

import kit from "@vite-hub/kit/nuxt";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function loadApp(options: { prefix?: string }) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-kit-nuxt-"));
  roots.push(root);
  await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n");
  return loadNuxt({ cwd: root, overrides: { dev: false, modules: [[kit, options]] }, ready: true });
}

describe("@vite-hub/kit Nuxt module", () => {
  it("auto-imports the kit's own parts from @vite-hub/kit, with the prefix", async () => {
    const nuxt = await loadApp({ prefix: "Ui" });
    try {
      const components: Array<{ export?: string; filePath: string; pascalName?: string }> = [];
      await nuxt.callHook("components:extend", components as never);
      expect(components).toEqual(expect.arrayContaining([
        expect.objectContaining({ export: "TagsInputItem", filePath: "@vite-hub/kit/tags-input", pascalName: "UiTagsInputItem" }),
      ]));
    } finally {
      await nuxt.close();
    }
  });

  it("leaves ui-sdk's parts to @ui-sdk/vue/nuxt", async () => {
    const nuxt = await loadApp({});
    try {
      expect(nuxt.options._installedModules.map((module) => module.meta?.name)).not.toContain("@ui-sdk/vue");
      const components: Array<{ filePath: string; pascalName?: string }> = [];
      await nuxt.callHook("components:extend", components as never);
      expect(components).toEqual(expect.arrayContaining([
        expect.objectContaining({ filePath: "@vite-hub/kit/tags-input", pascalName: "TagsInput" }),
      ]));
      expect(components.filter((component) => component.filePath.startsWith("@ui-sdk/"))).toEqual([]);
    } finally {
      await nuxt.close();
    }
  });
});
