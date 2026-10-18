import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { registerViteHubNitroDevEndpoint, renderViteHubNitroDevHandler } from "@vite-hub/internal/dev-endpoint"
import { createViteHubDevToken, removeViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { isViteHubSecretEqual } from "@vite-hub/internal/secret"

import {
  workspaceHistoryDevHeader,
  workspaceHistoryDevHeaderValue,
  workspaceHistoryDevRoute,
  workspaceHistoryDevRuntimeRoute,
  workspaceHistoryDevTokenNamespace,
  workspaceHistoryDevTokenServerHeader,
} from "../../history-dev.ts"

import type { ViteHubNitroDevServer } from "@vite-hub/internal/dev-endpoint"

const generatedNitroHistoryDevHandlerDirectory = ".vitehub/nitro/workspace/history-dev"

/** Message that the history dev endpoint returns when the host does not run Nitro in the Vite process. */
export const workspaceHistoryDevRuntimeUnavailableMessage = "This Vite Development Server does not run Nitro in process, so it cannot reach the Workspace runtime. `vitehub workspace history`, `refs`, and `show` need a Vite + Nitro host. Nuxt and plain Vite are not supported."

export type WorkspaceHistoryDevServer = ViteHubNitroDevServer & {
  httpServer?: { once: (event: "close", listener: () => void) => unknown } | null
}

/**
 * Writes the dev-only Nitro route that runs history reads, and returns its absolute path. The file name carries the
 * server id, so a second Vite process for the same project does not replace the route of a running server.
 */
export async function writeWorkspaceHistoryDevHandler(options: { importBase: string, projectRoot: string, serverId: string }): Promise<string> {
  const handler = resolve(options.projectRoot, generatedNitroHistoryDevHandlerDirectory, `${options.serverId}.ts`)
  const contents = renderViteHubNitroDevHandler({
    context: { rootDir: options.projectRoot, serverId: options.serverId },
    export: "handleWorkspaceHistoryDevRequest",
    module: `${options.importBase}/internal/runtime/history-dev`,
  })
  await mkdir(dirname(handler), { recursive: true })
  if (!existsSync(handler) || await readFile(handler, "utf8") !== contents) await writeFile(handler, contents, "utf8")
  return handler
}

/**
 * Registers the guarded endpoint of `vitehub workspace history`, `refs`, and `show` on a Vite Development Server.
 *
 * `GET` reports the root and whether the Nitro runtime is reachable. `POST` forwards one read into the Nitro dev
 * environment, because the Nitro runtime owns the Workspace registry and the Blob and Database bindings of its Stores.
 * The private token is removed when the server closes.
 */
export async function registerWorkspaceHistoryDevEndpoint(server: WorkspaceHistoryDevServer, options: {
  /** False when the Nitro config has no history route, for example because no Workspace Definition exists. */
  available: () => boolean
  nitroBaseURL?: () => string | undefined
  projectRoot: string
  serverId: string
}): Promise<() => Promise<void>> {
  const { serverId, token } = await createViteHubDevToken(options.projectRoot, workspaceHistoryDevTokenNamespace, options.serverId)
  let activeToken: string | undefined = token
  let closePromise: Promise<void> | undefined
  const close = () => {
    activeToken = undefined
    return closePromise ??= removeViteHubDevToken(options.projectRoot, { namespace: workspaceHistoryDevTokenNamespace, serverId })
  }
  server.httpServer?.once("close", () => { void close().catch(() => {}) })
  try {
    registerViteHubNitroDevEndpoint(server, {
      authorize: async ({ headers }) => {
        const requestToken = headers[viteHubDevTokenHeader]
        if (!isViteHubSecretEqual(Array.isArray(requestToken) ? undefined : requestToken, activeToken) || headers[workspaceHistoryDevTokenServerHeader] !== serverId) {
          return new Response("Forbidden Workspace History token.", { status: 403 })
        }
        if (!options.available()) {
          return Response.json({ error: { code: "WORKSPACE_HISTORY_DEV_UNAVAILABLE", message: "The Nitro runtime of this server has no Workspace Definitions." } }, { status: 404 })
        }
      },
      discovery: { workspaceHistoryDevTokenServerId: serverId },
      forwardHeaders: [viteHubDevTokenHeader, workspaceHistoryDevTokenServerHeader],
      header: workspaceHistoryDevHeader,
      headerValue: workspaceHistoryDevHeaderValue,
      label: "Workspace History",
      nitroBaseURL: options.nitroBaseURL,
      route: workspaceHistoryDevRoute,
      runtimeRoute: workspaceHistoryDevRuntimeRoute,
      unavailable: { code: "WORKSPACE_HISTORY_DEV_RUNTIME_UNAVAILABLE", message: workspaceHistoryDevRuntimeUnavailableMessage },
    })
  }
  catch (error) {
    await close()
    throw error
  }
  return close
}
