import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadNuxt } from "nuxt";

import { componentNames } from "../src/component-names.ts";
import { viteHubUIIcons } from "../src/icons.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("ViteHub UI Nuxt module", () => {
  it("registers styles, runtime defaults, and public components without Nuxt UI", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-ui-nuxt-"));
    roots.push(root);
    await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n");
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href;
    const viteHubUI = (await import(moduleUrl)).default as never;
    const nuxt = await loadNuxt({
      cwd: root,
      overrides: {
        dev: false,
        modules: [[viteHubUI, { defaults: { messageScroller: { edgeThreshold: 12 } } }]],
      },
      ready: true,
    });
    try {
      // The parts render the ui-sdk components, so the module installs no Nuxt UI.
      const installed = nuxt.options._installedModules.map((module) => module.meta?.name);
      expect(installed).toContain("@vite-hub/ui");
      expect(installed).not.toContain("@nuxt/ui");
      expect(nuxt.options.css).toEqual(
        expect.arrayContaining([expect.stringMatching(/\/dist\/styles\.css$/)]),
      );
      expect(nuxt.options.runtimeConfig.public.viteHubUI).toMatchObject({
        defaults: { messageScroller: { edgeThreshold: 12 } },
      });
      expect(
        nuxt.options.plugins.some((plugin) =>
          String(typeof plugin === "string" ? plugin : plugin.src).endsWith(
            "/dist/runtime/nuxt-plugin.js",
          ),
        ),
      ).toBe(true);

      // Nitro's server build cannot bundle the raw `onig.wasm` that Shiki's `unwasm` condition gives `shiki/wasm`.
      expect(nuxt.options.vite.resolve?.alias).toEqual(
        expect.arrayContaining([
          { find: "shiki/wasm", replacement: expect.stringMatching(/\/@shikijs\/engine-oniguruma\/dist\/wasm-inlined\.mjs$/) },
          { find: "virtual:vitehub-ui-components", replacement: expect.stringMatching(/\/dist\/runtime\/no-components\.js$/) },
        ]),
      );

      const components: Array<{ export?: string; filePath?: string; pascalName?: string }> = [];
      await nuxt.callHook("components:extend", components as never);
      expect(components).toEqual(
        expect.arrayContaining(
          componentNames.map((name) =>
            expect.objectContaining({ export: name, filePath: expect.stringMatching(/\/dist\/index\.js$/) }),
          ),
        ),
      );

      const icons = new Set(["app:existing"]);
      // @nuxt/icon types its hooks on @nuxt/schema 4.6, not on the schema of this Nuxt 5 instance.
      const callIconHook = nuxt.callHook as (name: "icon:clientBundleIcons", icons: Set<string>) => Promise<void>;
      await callIconHook("icon:clientBundleIcons", icons);
      expect([...icons]).toEqual(expect.arrayContaining(["app:existing", ...viteHubUIIcons]));
    } finally {
      await nuxt.close();
    }
  });

  it("gives the parts the components of the `components` module", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-ui-nuxt-"));
    roots.push(root);
    const components = join(root, "components.ts");
    await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n");
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href;
    const viteHubUI = (await import(moduleUrl)).default as never;
    const nuxt = await loadNuxt({ cwd: root, overrides: { dev: false, modules: [[viteHubUI, { components }]] }, ready: true });
    try {
      expect(nuxt.options.vite.resolve?.alias).toEqual(expect.arrayContaining([{ find: "virtual:vitehub-ui-components", replacement: components }]));
      expect(nuxt.options.runtimeConfig.public.viteHubUI).not.toHaveProperty("components");
    } finally {
      await nuxt.close();
    }
  });
});
