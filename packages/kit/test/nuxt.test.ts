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
  // SAFETY: `KitNuxtModule` keeps @nuxt/schema out of the public declarations. Nuxt takes the module as it is.
  return loadNuxt({ cwd: root, overrides: { dev: false, modules: [[kit as never, options]] }, ready: true });
}

describe("@vite-hub/kit Nuxt module", () => {
  it("auto-imports the parts and helpers from @vite-hub/kit, with the prefix", async () => {
    const nuxt = await loadApp({ prefix: "Ui" });
    try {
      expect(nuxt.options._installedModules.map((module) => module.meta?.name)).toEqual(
        expect.arrayContaining(["@vite-hub/kit", "@ui-sdk/vue"]),
      );

      const components: Array<{ export?: string; filePath: string; pascalName?: string }> = [];
      await nuxt.callHook("components:extend", components as never);
      expect(components).toEqual(expect.arrayContaining([
        expect.objectContaining({ export: "Dialog", filePath: "@vite-hub/kit/dialog", pascalName: "UiDialog" }),
        expect.objectContaining({ export: "TabsTab", filePath: "@vite-hub/kit/tabs", pascalName: "UiTabsTab" }),
        expect.objectContaining({ export: "OTPInput", filePath: "@vite-hub/kit/otp-input", pascalName: "UiOTPInput" }),
        expect.objectContaining({ export: "Form", filePath: "@vite-hub/kit/form", pascalName: "UiForm" }),
        expect.objectContaining({ export: "TagsInputItem", filePath: "@vite-hub/kit/tags-input", pascalName: "UiTagsInputItem" }),
      ]));
      expect(components.filter((component) => component.filePath.startsWith("@ui-sdk/"))).toEqual([]);

      const sources: Array<{ from?: string; imports: unknown[] }> = [];
      await nuxt.callHook("imports:sources", sources as never);
      expect(sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: "@vite-hub/kit/dialog", imports: expect.arrayContaining(["createDialogController"]) }),
        expect.objectContaining({ from: "@vite-hub/kit/number", imports: expect.arrayContaining(["formatNumber"]) }),
      ]));
      expect(sources.filter((source) => source.from?.startsWith("@ui-sdk/"))).toEqual([]);
    } finally {
      await nuxt.close();
    }
  });

  it("registers the ui-sdk names without a prefix by default", async () => {
    const nuxt = await loadApp({});
    try {
      const components: Array<{ filePath: string; pascalName?: string }> = [];
      await nuxt.callHook("components:extend", components as never);
      expect(components).toEqual(expect.arrayContaining([
        expect.objectContaining({ filePath: "@vite-hub/kit/dialog", pascalName: "DialogTrigger" }),
      ]));
    } finally {
      await nuxt.close();
    }
  });
});
