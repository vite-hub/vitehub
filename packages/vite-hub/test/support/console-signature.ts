import { createConsoleKeyPair, signConsoleRequest } from "@vite-hub/internal/console-signature"

import { consoleRpcHeader } from "../../src/console/runtime/rpc.ts"
import { operationRpcBody } from "../../../internal/test-utils/operation-rpc.ts"

import type { ConsoleCaller, ConsoleCallerUser, ConsoleSigningKey } from "@vite-hub/internal/console-signature"

/** A real Ed25519 key pair, named `name`, and the env line that an app keeps for it. */
export async function consoleTestKey(name = "CI"): Promise<{ env: Record<string, string>, key: ConsoleSigningKey, publicKey: string }> {
  const pair = await createConsoleKeyPair()
  return { env: { [`VITEHUB_CONSOLE_KEY_${name}`]: pair.publicKey }, key: { name, privateKey: pair.privateKey }, publicKey: pair.publicKey }
}

/** A signed `POST /_vitehub/rpc` request, as the CLI or the Console sends it. */
export async function signedRpcRequest(options: {
  body?: string
  caller?: ConsoleCaller
  headers?: Record<string, string>
  input?: unknown
  key: ConsoleSigningKey
  now?: number
  operation?: string
  url?: string
}): Promise<Request> {
  const url = options.url ?? "https://app.example.com/_vitehub/rpc"
  const body = options.body ?? operationRpcBody(options.operation ?? "sections.list", options.input ?? {})
  const signed = await signConsoleRequest({ body, caller: options.caller ?? { via: "cli" }, key: options.key, method: "POST", url, ...(options.now === undefined ? {} : { now: options.now }) })
  return new Request(url, {
    body,
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1", ...signed, ...options.headers },
    method: "POST",
  })
}

/**
 * Take only signed calls, as an app with `console: true` does: install `token` access with one test key in
 * `process.env`. `sign()` signs a request as the Console for `user`, or as the CLI without one. `restore()` removes the key.
 */
export async function signedConsoleAccess(name = "CI"): Promise<{ key: ConsoleSigningKey, restore(): void, sign(request: Request, user?: ConsoleCallerUser): Promise<Request> }> {
  const { installConsoleAccess } = await import("../../src/console/runtime/server/access.ts")
  const { env, key } = await consoleTestKey(name)
  const variable = Object.keys(env)[0]!
  const previous = process.env[variable]
  process.env[variable] = env[variable]
  installConsoleAccess({ mode: "token" })
  return {
    key,
    restore() {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    },
    async sign(request, user) {
      const body = await request.clone().text()
      const caller: ConsoleCaller = user ? { via: "console", user } : { via: "cli" }
      const headers = new Headers(request.headers)
      for (const [header, value] of Object.entries(await signConsoleRequest({ body, caller, key, method: request.method, url: request.url }))) headers.set(header, value)
      return new Request(request.url, { body, headers, method: request.method })
    },
  }
}
