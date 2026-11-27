import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import ts from "typescript"
import { expect, it } from "vitest"
import { writeQueueTypes } from "../src/registry-types.ts"

it.each(["@vite-hub/queue", "vite-hub/queue"])("checks %s dispatch through generated definition imports", async (importBase) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-queue-types-"))
  try {
    await symlink(resolve(import.meta.dirname, "../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), '{"type":"module"}')
    const handler = join(root, "welcome.queue.ts")
    await writeFile(handler, [
      `import { defineQueue } from ${JSON.stringify(importBase)}`,
      'export default defineQueue<{ email: string }>({ handler: ({ payload }) => payload.email })',
    ].join("\n"))
    await writeQueueTypes(root, [{ handler, name: "welcome" }], importBase)
    const consumer = join(root, "consumer.ts")
    await writeFile(consumer, [
      `import { sendQueue, useQueue, dynamicQueue } from ${JSON.stringify(importBase)}`,
      'const [error, result] = await sendQueue("welcome", { email: "ada@example.test" }, { delay: "5s" })',
      'if (error) error.code satisfies "QUEUE_PROVIDER_FAILED" | "QUEUE_PROVIDER_INVALID_RESPONSE" | "QUEUE_UNSUPPORTED_OPTION" | "RUNTIME_DURATION_INVALID"',
      'else result.status satisfies "queued"',
      'const queue = await useQueue("welcome")',
      'await queue.send({ email: "ada@example.test" })',
      '// @ts-expect-error Wrong payload for generated definition.',
      'await sendQueue("welcome", { count: 1 })',
      '// @ts-expect-error The named client also knows its payload.',
      'await queue.send({ count: 1 })',
      '// @ts-expect-error Unknown names require operational dispatch.',
      'await sendQueue("missing", { email: "ada@example.test" })',
      'await dynamicQueue.send("external", { arbitrary: true })',
    ].join("\n"))
    const program = ts.createProgram([consumer, join(root, ".vitehub/queue.d.ts")], {
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ESNext,
      types: [],
      paths: {
        "@vite-hub/queue": [resolve(import.meta.dirname, "../dist/index.d.ts")],
        "vite-hub/queue": [resolve(import.meta.dirname, "../../vite-hub/src/queue.ts")],
      },
    })
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}, 30_000)
