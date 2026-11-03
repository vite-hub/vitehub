import { resolve } from "node:path"
import { writeFileIfChanged } from "./definition-catalog.ts"
import { createNitroServerKit } from "./nitro-kit.ts"
import { collectOperationContributions, operationRpcPath } from "./operations.ts"
import { flattenPluginOptions } from "./contributions.ts"
import { readViteHubDevServerFile, removeViteHubDevServerFile, writeViteHubDevServerFile } from "./cli.ts"

const owners = new Set(["@vite-hub/kv/operations", "@vite-hub/blob/operations", "@vite-hub/email/operations", "@vite-hub/rate-limit/operations"])
const discoveryInstalled = Symbol.for("vitehub.operations.dev.discovery")

interface OperationDevServer {
  config: { root: string, base: string, server: { https?: unknown } }
  httpServer: {
    address(): string | { address: string, family: string, port: number } | null
    listening: boolean
    once(event: "listening" | "close", listener: () => void): unknown
  } | null
  resolvedUrls: { local: string[] } | null
}

/** Publish only the elected standalone transport; other Console policies retain their own discovery hook. */
export function publishStandaloneOperationServer(server: OperationDevServer): void {
  const http = server.httpServer
  if (!http || Reflect.get(server, discoveryInstalled)) return
  const root = resolve(server.config.root)
  const handlers: unknown = Reflect.get(Object(Reflect.get(server.config, "nitro")), "handlers")
  if (!Array.isArray(handlers) || !handlers.some(handler => handler?.handler === resolve(root, ".vitehub/nitro/operations/rpc.mjs"))) return
  Reflect.set(server, discoveryInstalled, true)
  let ownedUrl: string | undefined
  const write = () => {
    const address = http.address()
    if (!address || typeof address === "string") return
    const host = address.address === "::" || address.address === "0.0.0.0" ? "localhost" : address.family === "IPv6" ? `[${address.address}]` : address.address
    const url = server.resolvedUrls?.local[0] ?? `${server.config.server.https ? "https" : "http"}://${host}:${address.port}${server.config.base}`
    try {
      writeViteHubDevServerFile(root, { root, url })
      ownedUrl = url
    }
    catch { /* A read-only root can use VITEHUB_DEV_SERVER_URL. */ }
  }
  if (http.listening) write()
  else http.once("listening", write)
  http.once("close", () => {
    try {
      if (ownedUrl && readViteHubDevServerFile(root)?.url === ownedUrl) removeViteHubDevServerFile(root)
    }
    catch { /* Discovery is advisory. */ }
  })
}

/** Standalone primitives share one local Nitro RPC. The root integration owns its own access policy. */
export async function installStandaloneOperationRpc(config: { root?: string, plugins?: readonly unknown[] }, command: "serve" | "build", module: string): Promise<void> {
  if (command !== "serve") return
  const plugins = await flattenPluginOptions(config.plugins)
  if (plugins.some(plugin => Reflect.get(plugin, "name") === "vite-hub/dependencies" || Reflect.get(plugin, "name") === "vite-hub/console")) return
  const contributions = (await collectOperationContributions(plugins)).filter(source => source.runtime !== false)
  if (contributions.find(source => owners.has(source.module))?.module !== module) return
  const root = resolve(config.root ?? process.cwd())
  const handler = resolve(root, ".vitehub/nitro/operations/rpc.mjs")
  const source = [
    `import { createStandaloneOperationHandler } from ${JSON.stringify(module)}`,
    ...contributions.map((entry, index) => `import * as source${index} from ${JSON.stringify(entry.module)}`),
    `export default createStandaloneOperationHandler([${contributions.map((entry, index) => `{ operations: source${index}[${JSON.stringify(entry.export)}], plugin: ${JSON.stringify(entry.plugin)} }`).join(", ")}], ${JSON.stringify(root)})`,
    "",
  ].join("\n")
  await writeFileIfChanged(handler, source)
  const kit = createNitroServerKit(Reflect.get(config, "nitro"))
  kit.addHandler({ handler, route: operationRpcPath })
  Reflect.set(config, "nitro", kit.config)
}
