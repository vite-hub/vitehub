import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadNuxt } from "nuxt";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("ViteHub UI Nuxt module", () => {
  it("registers Nuxt UI, styles, runtime defaults, and public components", async () => {
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
      expect(nuxt.options.css).toContain("@vite-hub/ui/styles.css");
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

      const components: Array<{ export?: string; filePath?: string; pascalName?: string }> = [];
      await nuxt.callHook("components:extend", components as never);
      expect(components).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ export: "AgentChat", filePath: "@vite-hub/ui" }),
          expect.objectContaining({ export: "AgentSession", filePath: "@vite-hub/ui" }),
          expect.objectContaining({ export: "AgentTrace", filePath: "@vite-hub/ui" }),
        ]),
      );
    } finally {
      await nuxt.close();
    }
  });
});
