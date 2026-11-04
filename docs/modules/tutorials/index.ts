import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { webContainerHeaders } from "@vite-hub/web-container/vite";
import { addTemplate, addTypeTemplate, defineNuxtModule, updateTemplates } from "nuxt/kit";
import { buildRunnableTutorial, createZip, readWorkspaceVersions, tutorialStepFiles } from "./build";
import { runnableTutorials } from "./list";
import { buildPlaygroundTemplates, snapshotSources } from "./playground";
import { buildTutorialSnapshots, readTutorialSnapshots } from "./snapshots";

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
 * `/playground` boots the same workspace without a lesson, so it sends them too, and no other page does.
 * `app/middleware/isolation-boundary.global.ts` loads a new document for links across this boundary.
 *
 * At build time this module reads each lesson and its fixture, and writes:
 * - `#build/runnable-tutorials.mjs`: the files before step 1 and the files that each step writes.
 * - `#build/playground-templates.mjs`: the files of each playground template, read from its fixture.
 * - `/_tutorials/<slug>-starter.zip`: the files at the start of step 1, for readers who cannot run the workspace.
 * - `/_tutorials/snapshots/<slug>.<hash>.<part>.bin`: the `node_modules` of the workspace, so the browser skips
 *   `npm install`. A playground template with the dependencies of a tutorial mounts the snapshot of that tutorial.
 *   `nuxt build` writes them. `nuxt dev` reuses the last ones; set `TUTORIAL_SNAPSHOTS=1` to build them
 *   in development, or `TUTORIAL_SNAPSHOTS=0` to skip them in a build. Without them the workspace installs.
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
      "/playground": { headers: { ...webContainerHeaders } },
      // A content hash names each part, so a part never changes.
      "/_tutorials/snapshots/**": { headers: { "cache-control": "public, max-age=31536000, immutable" } },
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
    const fixturesDir = resolve(repoRoot, "fixtures/tutorials");
    const buildTemplates = () => buildPlaygroundTemplates({ fixturesDir, versions, tutorials: runnableTutorials });
    const templates = await buildTemplates();
    // Not in buildDir: Nuxt empties it after modules set up, before Nitro copies public assets.
    const assetsDir = resolve(nuxt.options.rootDir, "node_modules/.cache/runnable-tutorials");
    await mkdir(assetsDir, { recursive: true });
    for (const tutorial of tutorials) {
      await writeFile(resolve(assetsDir, `${tutorial.slug}-starter.zip`), createZip(tutorialStepFiles(tutorial, 0, "start"), tutorial.slug));
    }

    let snapshots = await readTutorialSnapshots(assetsDir, { disabled: process.env.TUTORIAL_SNAPSHOTS === "0" });
    // `nuxi prepare` calls `build:before` too, and it runs on every install and test.
    const buildSnapshots = !nuxt.options._prepare && (process.env.TUTORIAL_SNAPSHOTS ?? (nuxt.options.dev ? "0" : "1")) === "1";
    nuxt.hook("build:before", async () => {
      if (!buildSnapshots) return;
      snapshots = await buildTutorialSnapshots({
        tutorials: snapshotSources(runnableTutorials, templates),
        repoRoot,
        fixturesDir,
        versions,
        outDir: assetsDir,
        baseURL: "/_tutorials",
        workDir: resolve(nuxt.options.rootDir, "node_modules/.cache/runnable-tutorials-work"),
      });
      // Nuxt wrote the templates before this hook, with the snapshots of the last build.
      await updateTemplates({ filter: template => template.filename === "runnable-tutorials.mjs" || template.filename === "playground-templates.mjs" });
    });

    addTemplate({
      filename: "runnable-tutorials.mjs",
      write: true,
      // The lesson or the fixture can change in development, so read them again on each write.
      getContents: async () => {
        const data = (nuxt.options.dev ? await build() : tutorials).map(tutorial => ({ ...tutorial, snapshot: snapshots?.[tutorial.slug] }));
        return `export const runnableTutorials = ${JSON.stringify(data)}\n`;
      },
    });
    addTemplate({
      filename: "playground-templates.mjs",
      write: true,
      getContents: async () => {
        const data = (nuxt.options.dev ? await buildTemplates() : templates).map(template => ({ ...template, snapshot: snapshots?.[template.snapshotOf] }));
        return `export const playgroundTemplates = ${JSON.stringify(data)}\n`;
      },
    });
    const steps = JSON.stringify(resolve(import.meta.dirname, "steps"));
    addTypeTemplate({
      filename: "types/runnable-tutorials.d.ts",
      getContents: () => [
        `declare module "#build/runnable-tutorials.mjs" {`,
        `  export const runnableTutorials: import(${steps}).RunnableTutorialData[]`,
        `}`,
        `declare module "#build/playground-templates.mjs" {`,
        `  export const playgroundTemplates: import(${steps}).PlaygroundTemplate[]`,
        `}`,
      ].join("\n"),
    });

    Reflect.apply(nuxt.hook, nuxt, ["nitro:config", (nitro: NitroConfig) => {
      nitro.publicAssets = [...nitro.publicAssets ?? [], { baseURL: "/_tutorials", dir: assetsDir }];
      nitro.prerender = { ...nitro.prerender, routes: [...nitro.prerender?.routes ?? [], ...tutorials.map(tutorial => `/tutorials/${tutorial.slug}`), "/playground"] };
    }]);
  },
});
