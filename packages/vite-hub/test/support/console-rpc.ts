import "./console-access.ts"

import { withConsoleAccess } from "../../src/console/runtime/server/access.ts"
import { handleConsoleRpcRequest as handleCheckedConsoleRpcRequest } from "../../src/console/runtime/server/rpc.ts"

/** Send one Console RPC request through the Console access guard, as the generated RPC route does. */
export function handleConsoleRpcRequest(request: Request, context: { env?: Record<string, unknown>, waitUntil?: (task: Promise<unknown>) => void } = {}): Promise<Response> {
  return withConsoleAccess((_event, access) => handleCheckedConsoleRpcRequest(request, { ...context, access }))({ req: request })
}
