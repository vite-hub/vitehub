import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { resolveConfig } from "vite"
import { expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { createProject } from "./support/content-cms.ts"

import type { Plugin } from "vite"

// The Schedule plugin writes the generated Nitro plugin in its `config` hook and again in `configResolved`. Vite runs
// the `configResolved` hooks concurrently, so `vite dev` can load the first copy. With Database off, that copy imported
// `vite-hub/database` from the plugins of the `cms` variant that Vite drops, and the dev server logged VITE_HUB_B0013.
it("writes the Schedule plugin of a Process Runtime without Database or KV from the config hook", async () => {
  const root = await createProject({
    "package.json": JSON.stringify({ name: "schedule-preliminary", private: true, type: "module" }),
    "server/schedules/morning-brief.ts": "import { defineSchedule } from 'vite-hub/schedule'\n\nexport default defineSchedule({ cron: '0 9 * * *', handler: () => {} })\n",
  })
  const pluginFile = join(root, ".vitehub/nitro/schedule/plugin.ts")
  let afterConfigHook: string | undefined
  // A plain plugin's `config` hook runs after the Schedule plugin's `enforce: "pre"` hook.
  const probe: Plugin = { name: "probe", async config() { afterConfigHook = await readFile(pluginFile, "utf8") } }

  await resolveConfig({ configFile: false, logLevel: "silent", plugins: [vitehub({ host: "node", schedule: { runtime: { driver: "process" } } }), probe], root }, "serve")

  expect(afterConfigHook).toContain("createMemoryScheduleRunStore")
  expect(afterConfigHook).not.toContain("vite-hub/database")
  expect(afterConfigHook).not.toContain("scheduleKVStorage")
  expect(await readFile(pluginFile, "utf8")).toBe(afterConfigHook)
}, 60_000)
