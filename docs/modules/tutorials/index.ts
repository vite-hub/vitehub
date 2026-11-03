import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { webContainerHeaders } from "@vite-hub/web-container/vite";
import { addTemplate, addTypeTemplate, defineNuxtModule } from "nuxt/kit";
import { buildRunnableTutorial, createZip, readWorkspaceVersions, tutorialStepFiles } from "./build";
import { runnableTutorials } from "./list";

import type { RunnableTutorialData } from "./build";

interface NitroConfig {
  publicAssets?: Array<{ baseURL?: string, dir: string }>
  prerender?: { routes?: string[] }
}

/**
 * Runnable tutorials: `/tutorials/<slug>` shows the lesson of a docs page beside a live workspace.
 *
 * A WebContainer needs a cross-origin isolated page, so `/tutorials` and every page below it send
 * `webContainerHeaders`. Other pages keep their headers, so their cross-origin embeds keep working.
 * `app/middleware/isolation-boundary.global.ts` loads a new document for links across this boundary.
 *
 * At build time this module reads each lesson and its fixture, and writes:
 * - `#build/runnable-tutorials.mjs`: the files before step 1 and the files that each step writes.
 * - `/_tutorials/<slug>-starter.zip`: the files at the start of step 1, for readers who cannot run the workspace.
 */
export default defineNuxtModule({
  meta: { name: "vitehub-runnable-tutorials" },
  async setup(_options, nuxt) {
    const docsRoot = nuxt.options.rootDir;
    const repoRoot = resolve(docsRoot, "..");
    const versions = await readWorkspaceVersions(repoRoot);

    nuxt.options.routeRules = {
      ...nuxt.options.routeRules,
      "/tutorials": { headers: { ...webContainerHeaders } },
      "/tutorials/**": { headers: { ...webContainerHeaders } },
    };

    async function build(): Promise<RunnableTutorialData[]> {
      return Promise.all(runnableTutorials.map(source => buildRunnableTutorial({
        source,
        contentDir: resolve(docsRoot, "content"),
        fixturesDir: resolve(repoRoot, "fixtures/tutorials"),
        versions,
      })));
    }

    const tutorials = await build();
    // Not in buildDir: Nuxt empties it after modules set up, before Nitro copies public assets.
    const assetsDir = resolve(nuxt.options.rootDir, "node_modules/.cache/runnable-tutorials");
    await mkdir(assetsDir, { recursive: true });
    for (const tutorial of tutorials) {
      await writeFile(resolve(assetsDir, `${tutorial.slug}-starter.zip`), createZip(tutorialStepFiles(tutorial, 0, "start"), tutorial.slug));
    }

    addTemplate({
      filename: "runnable-tutorials.mjs",
      write: true,
      // The lesson or the fixture can change in development, so read them again on each write.
      getContents: async () => `export const runnableTutorials = ${JSON.stringify(nuxt.options.dev ? await build() : tutorials)}\n`,
    });
    addTypeTemplate({
      filename: "types/runnable-tutorials.d.ts",
      getContents: () => [
        `declare module "#build/runnable-tutorials.mjs" {`,
        `  export const runnableTutorials: import(${JSON.stringify(resolve(import.meta.dirname, "steps"))}).RunnableTutorialData[]`,
        `}`,
      ].join("\n"),
    });

    Reflect.apply(nuxt.hook, nuxt, ["nitro:config", (nitro: NitroConfig) => {
      nitro.publicAssets = [...nitro.publicAssets ?? [], { baseURL: "/_tutorials", dir: assetsDir }];
      nitro.prerender = { ...nitro.prerender, routes: [...nitro.prerender?.routes ?? [], ...tutorials.map(tutorial => `/tutorials/${tutorial.slug}`)] };
    }]);
  },
});
