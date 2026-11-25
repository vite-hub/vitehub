import { isRecord } from "../object.ts"
import { runWithClientRequest } from "./client-request.ts"

const installed = Symbol.for("vitehub.client-request.installed")

function isRequest(value: unknown): value is Pick<Request, "headers" | "url"> {
  return isRecord(value) && typeof value.url === "string" && value.headers instanceof Headers
}

/** Keeps each request that the Nitro app serves for `clientRequest()`. Auth and Comments each ship it, so it wraps `fetch` once. */
export default function clientRequestPlugin(nitroApp: unknown): void {
  if (!isRecord(nitroApp)) return
  const h3 = nitroApp.h3
  const owner: Record<string | symbol, unknown> = isRecord(h3) && h3.fetch instanceof Function ? h3 : nitroApp
  const fetch = owner.fetch
  if (!(fetch instanceof Function) || owner[installed]) return
  owner[installed] = true
  owner.fetch = (request: unknown, ...rest: unknown[]) => {
    const call = () => Reflect.apply(fetch, owner, [request, ...rest])
    return isRequest(request) ? runWithClientRequest(request, call) : call()
  }
}
