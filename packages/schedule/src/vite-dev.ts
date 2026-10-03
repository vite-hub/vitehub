import { createViteHubDevToken, removeViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { registerViteHubNitroDevEndpoint } from "@vite-hub/internal/dev-endpoint"

import { scheduleDevHeader, scheduleDevHeaderValue, scheduleDevRoute, scheduleDevRuntimeRoute, scheduleDevTokenNamespace, scheduleDevTokenServerHeader } from "./dev.ts"

import type { ViteHubNitroDevServer } from "@vite-hub/internal/dev-endpoint"

/** Message that the Schedule dev endpoint returns when the host does not run Nitro in the Vite process. */
export const scheduleDevRuntimeUnavailableMessage = "This Vite Development Server does not run Nitro in process, so it cannot reach the Schedule runtime. `vitehub schedule` commands need a Vite + Nitro host. Nuxt and plain Vite are not supported."

export type ScheduleDevServer = ViteHubNitroDevServer & {
  httpServer?: { once: (event: "close", listener: () => void) => unknown } | null
}

export interface ScheduleDevEndpointOptions {
  /** Server identity already embedded in the generated Nitro handler. */
  serverId?: string
  /** Nitro `baseURL`. Nitro routes use this prefix. */
  nitroBaseURL?: () => string | undefined
}

/**
 * Registers the guarded `vitehub schedule` endpoint on a Vite Development Server.
 *
 * `GET` reports the root and whether the Nitro runtime is reachable. `POST` forwards one Schedule operation into the
 * Nitro dev environment, because the Nitro runtime owns the Schedule stores and registry. Hosts without an in-process
 * Nitro environment get `501` with a clear message.
 */
export async function registerScheduleDevEndpoint(server: ScheduleDevServer, options: ScheduleDevEndpointOptions = {}): Promise<() => Promise<void>> {
  const rootDir = server.config.root
  const { serverId, token } = await createViteHubDevToken(rootDir, scheduleDevTokenNamespace, options.serverId)
  let activeToken: string | undefined = token
  let closePromise: Promise<void> | undefined
  const close = () => {
    activeToken = undefined
    return closePromise ??= removeViteHubDevToken(rootDir, { namespace: scheduleDevTokenNamespace, serverId })
  }
  server.httpServer?.once("close", () => { void close().catch(() => {}) })
  try {
    registerViteHubNitroDevEndpoint(server, {
      authorize: async request => request.headers[viteHubDevTokenHeader] === activeToken
        && request.headers[scheduleDevTokenServerHeader] === serverId
        ? undefined : new Response("Forbidden Schedule Dev token.", { status: 403 }),
      discovery: { root: rootDir, scheduleDevTokenServerId: serverId },
      forwardHeaders: [viteHubDevTokenHeader, scheduleDevTokenServerHeader],
      header: scheduleDevHeader,
      headerValue: scheduleDevHeaderValue,
      label: "Schedule Dev",
      nitroBaseURL: options.nitroBaseURL,
      route: scheduleDevRoute,
      runtimeRoute: scheduleDevRuntimeRoute,
      unavailable: { code: "SCHEDULE_DEV_RUNTIME_UNAVAILABLE", message: scheduleDevRuntimeUnavailableMessage },
    })
  }
  catch (error) {
    await close()
    throw error
  }
  return close
}
