import { isRecord } from "@vite-hub/internal/object"

import { runWithClientRequest } from "../client-request.ts"

function isRequest(value: unknown): value is Pick<Request, "headers" | "url"> {
  return isRecord(value) && typeof value.url === "string" && value.headers instanceof Headers
}

export default function authClientRequestPlugin(nitroApp: unknown): void {
  if (!isRecord(nitroApp)) return
  const h3 = nitroApp.h3
  const owner: Record<string, unknown> = isRecord(h3) && h3.fetch instanceof Function ? h3 : nitroApp
  const fetch = owner.fetch
  if (!(fetch instanceof Function)) return
  owner.fetch = (request: unknown, ...rest: unknown[]) => {
    const call = () => Reflect.apply(fetch, owner, [request, ...rest])
    return isRequest(request) ? runWithClientRequest(request, call) : call()
  }
}
