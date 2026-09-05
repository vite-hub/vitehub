import { execFile } from "node:child_process"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { expect, it } from "vitest"
import { writeQueueTypes } from "../src/registry-types.ts"

const exec = promisify(execFile)
const require = createRequire(import.meta.url)

it.each(["@vite-hub/queue", "vite-hub/queue"])("checks %s dispatch through generated definition imports", async (importBase) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-queue-types-"))
  try {
    await symlink(resolve(import.meta.dirname, "../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), '{"type":"module"}')
    const handler = join(root, "welcome.queue.ts")
    await writeFile(handler, [
      `import { defineQueue } from ${JSON.stringify(importBase)}`,
      'export default defineQueue<{ email: string }>(job => job.payload.email)',
    ].join("\n"))
    await writeQueueTypes(root, [{ handler, name: "welcome" }], importBase)
    await writeFile(join(root, "consumer.ts"), [
      `import { runQueue, getQueue, dynamicQueue } from ${JSON.stringify(importBase)}`,
      'await runQueue("welcome", { email: "ada@example.test" }, { delaySeconds: 5 })',
      'const queue = await getQueue("welcome")',
      'await queue.send({ email: "ada@example.test" })',
      '// @ts-expect-error Wrong payload for generated definition.',
      'await runQueue("welcome", { count: 1 })',
      '// @ts-expect-error The named client also knows its payload.',
      'await queue.send({ count: 1 })',
      '// @ts-expect-error Unknown names require operational dispatch.',
      'await runQueue("missing", { email: "ada@example.test" })',
      'await dynamicQueue.run("external", { arbitrary: true })',
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
          "@vite-hub/queue": [resolve(import.meta.dirname, "../dist/index.d.ts")],
          "vite-hub/queue": [resolve(import.meta.dirname, "../../vite-hub/src/queue.ts")],
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
