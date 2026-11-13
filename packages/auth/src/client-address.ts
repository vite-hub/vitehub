import type { Auth } from "better-auth"

/**
 * Better Auth reads the client IP for its rate limiter and for `session.ipAddress` only from request headers. Auth puts
 * the address that the host reports in this header and removes any value that a client sends, at every entry of the
 * Better Auth instances that it creates: `handler` and each `api` endpoint.
 */
export const clientAddressHeader = "x-vitehub-client-address"

/** The addresses that `handleAuthRequest()` read from the request event, for the Request that it passes to Better Auth. */
const eventAddresses = new WeakMap<object, string>()

function readString(value: unknown, path: readonly string[]): string | undefined {
  let current = value
  for (const key of path) {
    if (current === null || (typeof current !== "object" && typeof current !== "function")) return undefined
    current = Reflect.get(current, key)
  }
  return typeof current === "string" && current ? current : undefined
}

/**
 * The client IP address that the host reports for a request event: Standard Context `runtime.clientAddress`, which is
 * `cf-connecting-ip` on Cloudflare and the peer address on Node. Forwarding headers such as `X-Forwarded-For` are
 * not read.
 */
export function eventClientAddress(event: unknown): string | undefined {
  return readString(event, ["~standard", "runtime", "clientAddress"])
}

/** Remember the host address of a Request that Auth passes to Better Auth. */
export function setRequestClientAddress(request: Request, address: string | undefined): Request {
  if (address) eventAddresses.set(request, address)
  return request
}

interface RequestInitWithDuplex extends RequestInit {
  duplex?: "half"
}

/** Return the request with only the host address in {@link clientAddressHeader}. srvx adds that address as `ip`. */
function addressedRequest(request: Request): Request {
  const address = eventAddresses.get(request) ?? readString(request, ["ip"])
  const sent = request.headers.get(clientAddressHeader)
  if (sent === (address ?? null)) return request
  const headers = new Headers(request.headers)
  if (address) headers.set(clientAddressHeader, address)
  else headers.delete(clientAddressHeader)
  // Copy the fields that Better Auth reads. `new Request(request)` fails for a Request of another realm.
  const init: RequestInitWithDuplex = { headers, method: request.method, redirect: request.redirect, signal: request.signal }
  if (request.body) {
    init.body = request.body
    init.duplex = "half"
  }
  return new Request(request.url, init)
}

type ApiInput = { headers?: ConstructorParameters<typeof Headers>[0], request?: Request } | undefined

/** Headers of an `api` call have no host address, so remove a value that the caller copied from client headers. */
function withoutClientAddress(input: ApiInput): ApiInput {
  if (!input || typeof input !== "object") return input
  let result = input
  if (input.headers) {
    const headers = new Headers(input.headers)
    if (headers.has(clientAddressHeader)) {
      headers.delete(clientAddressHeader)
      result = { ...result, headers }
    }
  }
  const request = input.request
  if (request && typeof request.url === "string" && typeof request.headers?.get === "function") {
    const addressed = addressedRequest(request)
    if (addressed !== request) result = { ...result, request: addressed }
  }
  return result
}

/** Give Better Auth the host address of each handler request, and only that address. */
export function withClientAddress(auth: Auth): Auth {
  const handler = auth.handler
  const addressedHandler: Auth["handler"] = request => handler(addressedRequest(request))
  // Better Auth exposes its API as an own data property. Do not invoke provider accessors during setup.
  const originalApi: Auth["api"] | undefined = Object.getOwnPropertyDescriptor(auth, "api")?.value
  if (originalApi) {
    const api = Object.fromEntries(Object.entries(originalApi).map(([name, endpoint]) => [name, Object.assign(
      (input?: ApiInput, ...rest: unknown[]) => Reflect.apply(endpoint, originalApi, [withoutClientAddress(input), ...rest]),
      endpoint,
    )]))
    // SAFETY: every endpoint keeps its arguments, result, and metadata; only the client address header is removed.
    auth.api = api as Auth["api"]
  }
  return Object.assign(auth, { handler: addressedHandler, fetch: addressedHandler })
}
