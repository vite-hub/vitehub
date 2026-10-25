import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { build } from "esbuild"
import { expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, "..")
const messageCodes = Array.from({ length: 23 }, (_, index) => `AGENT_R${String(646 + index).padStart(4, "0")}`)

it.each(["browser", "node"] as const)("bundles published messages without the Agent catalog for %s", async (platform) => {
  // Resolve package exports from dist, without the source aliases used by unit tests.
  const options = {
    absWorkingDir: packageRoot,
    bundle: true,
    format: "esm",
    metafile: true,
    minify: true,
    platform,
    target: "es2022",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
  } as const
  const consumer = await build({
    ...options,
    stdin: {
      contents: 'export { createMessage } from "@vite-hub/agent/messages"',
      resolveDir: packageRoot,
      sourcefile: "consumer.js",
    },
  })
  const code = consumer.outputFiles[0]!.text
  expect([...new Set(code.match(/AGENT_[A-Z]\d{4}/g))].sort()).toEqual(messageCodes)
  expect(Buffer.byteLength(code)).toBeLessThan(10_000)
  const retainedInputs = Object.values(consumer.metafile.outputs)
    .flatMap(output => Object.entries(output.inputs))
    .filter(([, input]) => input.bytesInOutput > 0)
    .map(([path]) => path.replaceAll("\\", "/"))
  expect(retainedInputs.some(path => /(?:^|\/)dist\/messages\.js$/.test(path))).toBe(true)
  expect(retainedInputs.some(path => /(?:^|\/)valibot\//.test(path))).toBe(false)
  expect(retainedInputs.some(path => /(?:^|\/)src\/.+\.ts$/.test(path))).toBe(false)

  const messages = await build({
    ...options,
    stdin: {
      contents: 'export * from "@vite-hub/agent/messages"; export { Diagnostic } from "nostics"',
      resolveDir: packageRoot,
      sourcefile: "diagnostics-consumer.js",
    },
  })
  const cache = join(packageRoot, "node_modules/.cache")
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "messages-consumer-"))
  try {
    const bundle = join(root, "messages.mjs")
    await writeFile(bundle, messages.outputFiles[0]!.text)
    const { stdout } = await execFileAsync(process.execPath, [
      resolve(import.meta.dirname, "fixtures/messages-diagnostics.mjs"), bundle,
    ])
    expect(stdout.trim()).toBe("23 message diagnostics passed")
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
