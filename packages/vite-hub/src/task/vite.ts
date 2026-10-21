import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { registerViteHubNitroDevEndpoint } from "@vite-hub/internal/dev-endpoint"
import { createViteHubDevToken, removeViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { summarizeDefinitions } from "@vite-hub/internal/inspect"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { isViteHubSecretEqual } from "@vite-hub/internal/secret"

import { createTaskCliContributor } from "./cli.ts"
import { taskDevHeader, taskDevHeaderValue, taskDevRoute, taskDevRuntimeRoute, taskDevTokenNamespace, taskDevTokenServerHeader } from "./dev.ts"
import { discoverTaskDefinitions } from "./discovery.ts"

import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { ViteHubNitroDevServer } from "@vite-hub/internal/dev-endpoint"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, ResolvedConfig } from "vite"

const generatedNitroDevHandler = ".vitehub/nitro/task/dev-handler.ts"

/** Message that the Task dev endpoint returns when the host does not run Nitro in the Vite process. */
export const taskDevRuntimeUnavailableMessage = "This Vite Development Server does not run Nitro in process, so it cannot run Nitro tasks. `vitehub task` commands need a Vite + Nitro host. In Nuxt, use Nuxt's own task support."

interface TaskViteConfig {
  nitro?: unknown
  root?: string
  [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
  [VITEHUB_SERVER_DIRS]?: string[]
}

type TaskDevServer = ViteHubNitroDevServer & {
  httpServer?: { once: (event: "close", listener: () => void) => unknown } | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value)
}

/**
 * Enables Nitro tasks for the discovered `server/tasks` files. The app keeps control: `nitro.experimental.tasks: false`
 * turns tasks off, and a task that `nitro.tasks` already declares keeps its handler and description.
 */
function addNitroTasks(value: unknown, definitions: ReturnType<typeof discoverTaskDefinitions>): Record<string, unknown> | undefined {
  const nitro = isRecord(value) ? { ...value } : {}
  const experimental = isRecord(nitro.experimental) ? nitro.experimental : {}
  if (experimental.tasks === false || (!definitions.length && experimental.tasks !== true)) return
  nitro.experimental = { ...experimental, tasks: true }
  const tasks = isRecord(nitro.tasks) ? { ...nitro.tasks } : {}
  for (const definition of definitions) {
    const existing = tasks[definition.name]
    tasks[definition.name] = isRecord(existing) ? { ...existing, handler: existing.handler ?? definition.handler } : { handler: definition.handler }
  }
  nitro.tasks = tasks
  return nitro
}

function renderNitroTaskDevHandler(rootDir: string): string {
  return [
    "import { defineEventHandler } from 'h3'",
    "import { tasks } from '#nitro/virtual/tasks'",
    "import { handleTaskDevRequest } from 'vite-hub/_internal/task/runtime/dev'",
    "",
    `export default defineEventHandler(event => handleTaskDevRequest(event.req, { rootDir: ${JSON.stringify(rootDir)}, tasks }))`,
    "",
  ].join("\n")
}

async function addNitroTaskDevHandler(value: unknown, projectRoot: string, viteRoot: string): Promise<Record<string, unknown>> {
  const handler = resolve(projectRoot, generatedNitroDevHandler)
  const contents = renderNitroTaskDevHandler(viteRoot)
  await mkdir(dirname(handler), { recursive: true })
  if (!existsSync(handler) || await readFile(handler, "utf8") !== contents) await writeFile(handler, contents, "utf8")
  const kit = createNitroServerKit(value)
  kit.addHandler({ handler, route: taskDevRuntimeRoute })
  return kit.config
}

/**
 * Registers the guarded `vitehub task` endpoint. A private token file scoped to this server proves that the caller
 * can read the project on this machine. The token is removed when the server closes.
 */
async function registerTaskDevEndpoint(server: TaskDevServer, nitroBaseURL: () => string | undefined): Promise<void> {
  const rootDir = server.config.root
  const { serverId, token } = await createViteHubDevToken(rootDir, taskDevTokenNamespace)
  let activeToken: string | undefined = token
  server.httpServer?.once("close", () => {
    activeToken = undefined
    void removeViteHubDevToken(rootDir, { namespace: taskDevTokenNamespace, serverId }).catch(() => {})
  })
  registerViteHubNitroDevEndpoint(server, {
    authorize: async ({ headers }) => isViteHubSecretEqual(Array.isArray(headers[viteHubDevTokenHeader]) ? undefined : headers[viteHubDevTokenHeader], activeToken)
      && headers[taskDevTokenServerHeader] === serverId
      ? undefined : new Response("Forbidden Task Dev token.", { status: 403 }),
    discovery: { root: rootDir, taskDevTokenServerId: serverId },
    forwardHeaders: [viteHubDevTokenHeader, taskDevTokenServerHeader],
    header: taskDevHeader,
    headerValue: taskDevHeaderValue,
    label: "Task Dev",
    nitroBaseURL,
    route: taskDevRoute,
    runtimeRoute: taskDevRuntimeRoute,
    unavailable: { code: "TASK_DEV_RUNTIME_UNAVAILABLE", message: taskDevRuntimeUnavailableMessage },
  })
}

/**
 * Connects Nitro tasks in `server/tasks/` to ViteHub: it registers them with Nitro, lists them in
 * `vitehub inspect definitions`, and adds the `vitehub task` commands.
 */
export function viteHubTaskPlugin(): Plugin & { vitehub: ViteHubCliPluginMetadata & ViteHubInspectionPluginMetadata } {
  let projectRoot = process.cwd()
  let serverDirs: string[] | undefined
  let resolved: ResolvedConfig | undefined
  let active = false

  return {
    name: "vite-hub/task",
    async config(config, env) {
      // SAFETY: Vite passes the mutable user config object, which ViteHub hosts augment through shared symbols.
      const viteConfig = config as TaskViteConfig
      // Nuxt runs its own Nitro, which scans `server/tasks` itself.
      if (viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) return
      const viteRoot = resolve(viteConfig.root || process.cwd())
      projectRoot = resolveViteHubProjectRoot(viteRoot)
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      const taskConfig = addNitroTasks(viteConfig.nitro, discoverTaskDefinitions(projectRoot, serverDirs))
      active = taskConfig !== undefined
      viteConfig.nitro = env.command === "serve" && taskConfig
        ? await addNitroTaskDevHandler(taskConfig, projectRoot, viteRoot)
        : taskConfig ?? viteConfig.nitro
    },
    configResolved(config) {
      resolved = config
    },
    async configureServer(server) {
      if (!active) return
      await registerTaskDevEndpoint(server, () => {
        const nitro: unknown = resolved ? Reflect.get(resolved, "nitro") : undefined
        const baseURL = isRecord(nitro) ? nitro.baseURL : undefined
        return typeof baseURL === "string" ? baseURL : process.env.NITRO_APP_BASE_URL
      })
    },
    vitehub: {
      cli: () => createTaskCliContributor(),
      inspect: () => ({
        definitions: [{
          kind: "task",
          label: "Tasks",
          list: () => summarizeDefinitions(projectRoot, discoverTaskDefinitions(projectRoot, serverDirs), "server-tasks"),
        }],
      }),
    },
  }
}
