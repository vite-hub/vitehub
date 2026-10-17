import { isViteHubSecretEqual } from "@vite-hub/internal/secret"
import { readViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"

import { scheduleDevTokenNamespace, scheduleDevTokenServerHeader } from "../dev.ts"
import { handleScheduleDevRequest as handleAuthorizedScheduleDevRequest } from "./console.ts"

import type { ScheduleDefinitionRegistry } from "../types.ts"

/** Node-only authentication for the development-only Nitro Schedule route. */
export async function handleScheduleDevRequest(request: Request, options: { registry?: ScheduleDefinitionRegistry, rootDir?: string, serverId?: string } = {}): Promise<Response> {
  return await handleAuthorizedScheduleDevRequest(request, { registry: options.registry, authorize: async request => {
    const serverId = request.headers.get(scheduleDevTokenServerHeader)
    const token = request.headers.get(viteHubDevTokenHeader)
    if (!options.serverId || serverId !== options.serverId || !token) return false
    return isViteHubSecretEqual(token, await readViteHubDevToken(options.rootDir ?? process.cwd(), { namespace: scheduleDevTokenNamespace, serverId }))
  } })
}
