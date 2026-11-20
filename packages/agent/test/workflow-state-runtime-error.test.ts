import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { build } from "esbuild"
import { expect, it } from "vitest"
import { hubAgent } from "../src/vite.ts"

const execute = promisify(execFile)

// On Vercel, the generated Workflow registry throws AGENT_R0893 when no State URL is set and AGENT_R0894 for a file: URL.
it("throws the coded State errors from the Workflow registry of a Vercel build", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-state-error-"))
  const source = resolve(import.meta.dirname, "../src")
  try {
    await symlink(resolve(import.meta.dirname, "../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), '{"type":"module"}')
    const plugin = hubAgent({})
    const configResolved: unknown = plugin.configResolved
    // SAFETY: hubAgent installs configResolved as an async Vite hook.
    await (configResolved as (config: Record<string, unknown>) => Promise<void>)({ command: "build", plugins: [], vitehub: { host: "vercel" }, root })
    const registryFile = join(root, ".vitehub/workflow/registry-runtime.mjs")
    await mkdir(join(root, ".vitehub/workflow"), { recursive: true })
    const registry = plugin.vitehub?.agent?.transformWorkflowRegistry("export default {}\n", registryFile)
    if (!registry) throw new Error("Expected Agent registry transform")
    expect(registry).toContain("AGENT_R0893")
    await writeFile(registryFile, registry)
    const entry = join(root, "worker.ts")
    await writeFile(entry, `
import ${JSON.stringify(registryFile)}
import { agentChannelDeliveryWorkflowStateResolver } from ${JSON.stringify(join(source, "server/route-handlers.ts"))}
const resolved = await agentChannelDeliveryWorkflowStateResolver()?.({}, {})
try {
  resolved?.state?.()
  console.log('no error')
} catch (error) {
  console.log(JSON.stringify({ code: error.code, name: error.name, message: error.message }))
}
`)
    const outfile = join(root, "worker.mjs")
    await build({
      entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm",
      plugins: [{
        name: "resolve-external-packages",
        setup(build) {
          build.onResolve({ filter: /[/\\]dist[/\\]/ }, (args) => {
            const dist = resolve(source, "../dist")
            if (args.path.startsWith(`${dist}/`)) {
              return { path: args.path.replace(dist, source).replace(/\.js$/, ".ts") }
            }
          })
          build.onResolve({ filter: /^[^./]/ }, async (args) => {
            if (args.pluginData?.resolved) return
            const resolved = await build.resolve(args.path, {
              resolveDir: args.resolveDir,
              kind: args.kind,
              pluginData: { resolved: true },
            })
            return { ...resolved, external: !/\.[cm]?tsx?$/.test(resolved.path) }
          })
        },
      }],
    })
    const env = { ...process.env, VERCEL: "", VERCEL_ENV: "", VITEHUB_AGENT_STATE_URL: "" }
    const missing = await execute(process.execPath, [outfile], { env })
    expect(JSON.parse(missing.stdout)).toMatchObject({ code: "AGENT_R0893" })
    const fileUrl = await execute(process.execPath, [outfile], { env: { ...env, VITEHUB_AGENT_STATE_URL: `file:${join(root, "agent.sqlite")}` } })
    expect(JSON.parse(fileUrl.stdout)).toMatchObject({ code: "AGENT_R0894" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
