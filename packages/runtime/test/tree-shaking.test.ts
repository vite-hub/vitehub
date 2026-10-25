import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "vite-plus"
import { expect, it } from "vitest"

async function bundle(exports: string): Promise<string> {
  const scratch = new URL("../node_modules/.cache/", import.meta.url)
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(fileURLToPath(scratch), "runtime-tree-shaking-"))
  try {
    const entry = join(root, "entry.ts")
    const runtime = fileURLToPath(new URL("../dist/index.js", import.meta.url))
    await writeFile(entry, `export { ${exports} } from ${JSON.stringify(runtime)}\n`)
    const result = await build({
      configFile: false,
      root,
      logLevel: "silent",
      build: { ssr: entry, write: false, minify: false },
      ssr: { noExternal: true },
    })
    const outputs = Array.isArray(result) ? result : [result]
    const chunks = outputs.flatMap(output => "output" in output ? output.output : [])
      .filter(output => output.type === "chunk")
    expect(chunks).toHaveLength(1)
    return chunks[0]!.code
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

it("removes unused authority descriptors from a built Runtime consumer", async () => {
  const code = await bundle("defineCapability")
  expect(code).not.toMatch(/\bcredentials\s*:/)
  expect(code).not.toMatch(/\bfilesystem\s*:/)
  // SAFETY: The consumer above re-exports this function from the built Runtime entry.
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as Pick<typeof import("../src/index.ts"), "defineCapability">
  expect(runtime.defineCapability("health", { status: "ready" })).toEqual({
    kind: "health", name: undefined, value: { status: "ready" },
  })
})

it("keeps used authority descriptors frozen in a built Runtime consumer", async () => {
  const code = await bundle("noExecutionAuthority, unknownExecutionAuthority, normalizeExecutionAuthority")
  // SAFETY: The consumer above re-exports these descriptors from the built Runtime entry.
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as Pick<typeof import("../src/index.ts"), "noExecutionAuthority" | "unknownExecutionAuthority" | "normalizeExecutionAuthority">
  expect(runtime.noExecutionAuthority.network).toBe("none")
  expect(runtime.unknownExecutionAuthority.network).toBe("unknown")
  for (const authority of [runtime.noExecutionAuthority, runtime.unknownExecutionAuthority]) {
    expect(Object.isFrozen(authority)).toBe(true)
    expect(Object.isFrozen(authority.filesystem)).toBe(true)
    expect(runtime.normalizeExecutionAuthority(authority)).toBe(authority)
  }
  const normalized = runtime.normalizeExecutionAuthority({ ...runtime.noExecutionAuthority })
  expect(normalized).not.toBe(runtime.noExecutionAuthority)
  expect(runtime.normalizeExecutionAuthority(normalized)).toBe(normalized)
})
