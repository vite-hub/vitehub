import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it } from "vitest"

import { generateProviderOutputs } from "../../schedule/src/internal/provider-output.ts"
import { createWorkflowRegistryContents } from "../../workflow/src/internal/vite-build.ts"

const imports = ["none", "definition", "all"] as const

async function createProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-nuxt-provider-imports-"))
  await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(rootDir, "node_modules"), "dir")
  return rootDir
}

describe("Nuxt Definition imports outside Nitro", () => {
  it.each(imports)("loads an emitted Vercel Schedule with %s explicit imports", async (bindings) => {
    const rootDir = await createProject()
    try {
      const handlerFile = join(rootDir, "server/schedules/cleanup.ts")
      await mkdir(dirname(handlerFile), { recursive: true })
      await mkdir(join(rootDir, "dist/client"), { recursive: true })
      await writeFile(handlerFile, [
        bindings !== "none" ? "import { defineSchedule } from 'vite-hub/schedule'" : "",
        bindings === "all" ? "import { kv } from 'vite-hub/kv'" : "",
        "export default defineSchedule({ cron: '0 0 * * *', handler: () => {",
        "  if (typeof kv.store('reports').get !== 'function') throw new Error('Missing KV helper')",
        "} })",
      ].join("\n"))
      await generateProviderOutputs({ clientOutDir: "dist/client", host: "vercel", rootDir })

      const output = join(rootDir, ".vercel/output/functions/api/vitehub/schedules/vercel/cleanup.func/index.mjs")
      // SAFETY: The real Schedule generator emits this request/response handler contract.
      const generated = await import(pathToFileURL(output).href) as {
        default: (req: { headers: Record<string, string>, url: string }, res: { end: () => void, statusCode?: number }) => Promise<void>
      }
      const response = { end: () => {}, statusCode: 0 }
      const invocation = generated.default({ headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` }, url: "/" }, response)
      if (bindings === "all") {
        await invocation
        expect(response.statusCode).toBe(204)
      }
      else {
        await expect(invocation).rejects.toThrow(`${bindings === "none" ? "defineSchedule" : "kv"} is not defined`)
      }
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it.each(imports)("loads a provider Workflow registry with %s explicit imports", async (bindings) => {
    const rootDir = await createProject()
    try {
      const handlerFile = join(rootDir, "server/workflows/cleanup.mjs")
      const registryFile = join(rootDir, "registry.mjs")
      await mkdir(dirname(handlerFile), { recursive: true })
      await writeFile(handlerFile, [
        bindings !== "none" ? "import { defineWorkflow } from 'vite-hub/workflow'" : "",
        bindings === "all" ? "import { kv } from 'vite-hub/kv'" : "",
        "export default defineWorkflow('cleanup', async () => typeof kv.store('reports').get)",
      ].join("\n"))
      await writeFile(registryFile, createWorkflowRegistryContents(registryFile, [{
        handler: handlerFile, name: "cleanup", source: "server-workflows",
      }]))

      // SAFETY: The provider registry above loads this exact Workflow Definition fixture.
      const generated = await import(pathToFileURL(registryFile).href) as {
        default: { cleanup: () => Promise<{ default: { handler: () => Promise<string> } }> }
      }
      const invocation = generated.default.cleanup().then(loaded => loaded.default.handler())
      if (bindings === "all") await expect(invocation).resolves.toBe("function")
      else await expect(invocation).rejects.toThrow(`${bindings === "none" ? "defineWorkflow" : "kv"} is not defined`)
    }
    finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
