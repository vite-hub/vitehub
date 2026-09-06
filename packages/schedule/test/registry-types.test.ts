import { execFile } from "node:child_process"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { expect, it } from "vitest"
import { writeScheduleTypes } from "../src/registry-types.ts"

const exec = promisify(execFile)
const require = createRequire(import.meta.url)

it.each(["@vite-hub/schedule", "vite-hub/schedule"])("checks %s dispatch through generated definition imports", async (importBase) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-types-"))
  try {
    await symlink(resolve(import.meta.dirname, "../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), '{"type":"module"}')
    const handler = join(root, "welcome.schedule.ts")
    await writeFile(handler, [
      `import { defineScheduleTarget } from ${JSON.stringify(importBase)}`,
      'export default defineScheduleTarget<{ prompt: string }>({ handler: context => context.input?.prompt })',
    ].join("\n"))
    await writeScheduleTypes(root, [{ allowRuntimeSchedules: true, handler, name: "report" }], importBase)
    await writeFile(join(root, "consumer.ts"), [
      `import { schedules } from ${JSON.stringify(importBase)}`,
      'await schedules.create({ target: "report", cron: "0 9 * * *", input: { prompt: "hello" } })',
      'await schedules.update("id", { target: "report", input: { prompt: "hello" } })',
      '// @ts-expect-error Wrong input for the generated target.',
      'await schedules.create({ target: "report", cron: "0 9 * * *", input: { count: 1 } })',
      '// @ts-expect-error Unknown targets require operational dispatch.',
      'await schedules.create({ target: "missing", cron: "0 9 * * *" })',
      '// @ts-expect-error A stored ID alone cannot prove the input type.',
      'await schedules.update("id", { input: { prompt: "hello" } })',
      'await schedules.dynamic.create({ target: "external", cron: "0 9 * * *", input: { arbitrary: true } })',
    ].join("\n"))
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ESNext",
        paths: {
          "@vite-hub/schedule": [resolve(import.meta.dirname, "../dist/index.d.ts")],
          "vite-hub/schedule": [resolve(import.meta.dirname, "../../vite-hub/src/schedule.ts")],
        },
      },
      include: ["*.ts", ".vitehub/*.d.ts"],
    }))
    const result = await exec(process.execPath, [require.resolve("typescript/lib/tsc.js"), "-p", join(root, "tsconfig.json")])
    expect(result.stdout).toBe("")
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}, 30_000)
