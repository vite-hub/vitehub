import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { hubAgent } from "../src/vite.ts"
import type { ProviderDeploymentOutputWriter } from "@vite-hub/internal/build/deployment-output"
import type { ResolvedConfig } from "vite"

const finalized = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock("@vite-hub/internal/build/deployment-output", async (importOriginal) => ({
  ...await importOriginal<typeof import("@vite-hub/internal/build/deployment-output")>(),
  finalizeProviderDeploymentOutputs: finalized,
}))

vi.mock("@vite-hub/internal/build/vercel-runtime-packages", () => ({
  copyNodeRuntimePackages: vi.fn(async () => undefined),
  copyVercelFunctionRuntimePackages: vi.fn(async () => undefined),
}))

const roots: string[] = []
afterEach(async () => {
  finalized.mockClear()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

it.each([
  { retainMetadata: true, sameRoot: false, cloneBuild: false },
  { retainMetadata: true, sameRoot: true, cloneBuild: true },
  { retainMetadata: false, sameRoot: false, cloneBuild: false },
  { retainMetadata: false, sameRoot: true, cloneBuild: false },
])("keeps Agent output in its owning catalog across environment clones %j", async ({ retainMetadata, sameRoot, cloneBuild }) => {
  vi.stubEnv("VITEHUB_HOSTING", "netlify")
  const plugin = hubAgent({ providers: { state: { provider: "memory" } } })
  const configs: ResolvedConfig[] = []
  for (const name of ["first", "second"]) {
    const root = sameRoot && roots[0] ? roots[0] : await mkdtemp(join(tmpdir(), "vitehub-agent-build-isolation-"))
    if (!roots.includes(root)) roots.push(root)
    const server = join(root, `backend-${name}`)
    await mkdir(join(server, "agents"), { recursive: true })
    await writeFile(join(server, "agents", `${name}.ts`), "export default {}\n")
    // SAFETY: This fixture supplies the resolved fields read by Agent output generation.
    const config = {
      root, command: "build", plugins: [], build: { outDir: "dist" },
      resolve: { alias: [] }, [VITEHUB_SERVER_DIRS]: [server],
      define: {
        __VITEHUB_PUBLIC_URL__: JSON.stringify({ url: `https://${sameRoot ? "shared" : name}.example.com` }),
        __VITEHUB_APP_BASE_URL__: JSON.stringify(`/${sameRoot ? "shared" : name}/`),
      },
    } as unknown as ResolvedConfig
    configs.push(config)
  }
  for (const config of configs) await (plugin.configResolved as (config: ResolvedConfig) => Promise<void>)(config)
  for (const config of configs) {
    const clone = { ...config, build: cloneBuild ? { ...config.build } : config.build }
    if (!retainMetadata) {
      for (const key of Object.getOwnPropertySymbols(clone)) Reflect.deleteProperty(clone, key)
    }
    const context = { environment: { config: clone } }
    ;(plugin.buildStart as (this: typeof context) => void).call(context)
    await (plugin.buildEnd as (this: typeof context) => Promise<void>).call(context)
    const contributions = useProviderOutputCatalog(config).takeDeploymentContributions()
    expect(contributions).toHaveLength(1)
    expect(contributions[0]?.rootDir).toBe(config.root)
    const write = vi.fn<ProviderDeploymentOutputWriter>(async () => undefined)
    await contributions[0]!.write({
      readCloudflareState: async () => ({ wranglerConfig: {} }),
      signal: new AbortController().signal,
      write,
    })
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: config.root,
      netlify: expect.objectContaining({ functions: [expect.objectContaining({
        bundleOptions: expect.objectContaining({ define: config.define }),
      })] }),
    }))
    await (plugin.closeBundle as { handler(this: typeof context): Promise<void> }).handler.call(context)
    expect(finalized).toHaveBeenLastCalledWith(useProviderOutputCatalog(config))
    await contributions[0]?.discard?.()
  }
})


it.each([true, false])("rejects an unassociated Agent clone with shared URL %j before contributing output", async (sharedUrl) => {
  const plugin = hubAgent()
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-ambiguous-build-"))
  roots.push(root)
  const configs = ["first", "second"].map(name => ({
    root, command: "build", plugins: [], build: { outDir: "dist" },
    resolve: { alias: [{ find: "build-alias", replacement: join(root, name) }] },
    define: { __VITEHUB_PUBLIC_URL__: JSON.stringify(`https://${sharedUrl ? "shared" : name}.example.com`) },
  } as unknown as ResolvedConfig))
  for (const config of configs) await (plugin.configResolved as (config: ResolvedConfig) => Promise<void>)(config)
  for (const config of configs) useProviderOutputCatalog(config).replaceDeploymentContribution({ owner: "agent", rootDir: root, write: async () => undefined })
  const clone = { ...Object.fromEntries(Object.entries(configs[1]!)), build: { ...configs[1]!.build }, define: configs[0]!.define }
  const context = { environment: { config: clone } }
  expect(() => (plugin.buildStart as (this: typeof context) => void).call(context)).toThrow("Cannot identify the owning Agent build")
  await (plugin.buildEnd as (this: typeof context, error?: Error) => Promise<void>).call(context, new Error("Ambiguous build"))
  await (plugin.renderError as (this: typeof context, error: Error) => Promise<void>).call(context, new Error("Ambiguous render"))
  await (plugin.closeBundle as { handler(this: typeof context): Promise<void> }).handler.call(context)
  for (const config of configs) expect(useProviderOutputCatalog(config).takeDeploymentContributions()).toHaveLength(1)
})
