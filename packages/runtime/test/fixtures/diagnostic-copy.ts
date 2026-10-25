import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "vite-plus"
import type { DiagnosticInit } from "nostics"

interface DiagnosticCopy {
  create<TData = undefined>(init: DiagnosticInit<TData>): unknown
}

/** Bundles the installed Nostics dependency so its Diagnostic constructor differs from the test's copy. */
export async function loadDiagnosticCopy(packageRoot: URL): Promise<DiagnosticCopy> {
  // SAFETY: This fixture exports a constructor wrapper from the installed Nostics dependency.
  return await loadBundledCopy(packageRoot, 'import { Diagnostic } from "nostics"; export function create(init) { return new Diagnostic(init) }') as DiagnosticCopy
}

/** Loads one self-contained bundle with a distinct module identity. */
export async function loadBundledCopy(packageRoot: URL, source: string): Promise<unknown> {
  const cache = fileURLToPath(new URL("node_modules/.cache/", packageRoot))
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "diagnostic-copy-"))
  try {
    const entry = join(root, "entry.mjs")
    await writeFile(entry, source)
    const result = await build({
      configFile: false,
      root,
      logLevel: "silent",
      build: { ssr: entry, write: false },
      ssr: { noExternal: true },
    })
    const outputs = Array.isArray(result) ? result : [result]
    const chunks = outputs.flatMap(output => "output" in output ? output.output : [])
      .filter(output => output.type === "chunk")
    if (chunks.length !== 1) throw new Error("Expected one standalone fixture bundle")
    return await import(`data:text/javascript;base64,${Buffer.from(chunks[0]!.code).toString("base64")}`)
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}
