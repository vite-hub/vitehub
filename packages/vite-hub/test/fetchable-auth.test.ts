import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defineAuth } from "@vite-hub/auth"
import { createAuthForRequest, handleAuthRequest, setAuthRuntimeEnvResolver, toAuthRequest, withAuthorization } from "@vite-hub/auth/server"
import { deriveViteHubSecret } from "@vite-hub/internal/secret"
import { getStandardContext } from "@vite-hub/runtime"
import { defineCollection } from "@vite-hub/source"
import { defineCollectionHandler } from "@vite-hub/source/server"
import * as v from "valibot"
import { afterEach, expect, it, vi } from "vitest"

import { writeConsoleAuthHandlers, writeConsoleConnectionsActor } from "../src/console/auth-build.ts"
import { readConsoleSessionUser } from "../src/console/auth.ts"
import { consoleConnectionsActor, installConsoleAccess } from "../src/console/runtime/server/access.ts"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

afterEach(() => {
  vi.unstubAllEnvs()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
})

it.each(["Collection", "Connections"] as const)("keeps request-local Auth bindings on the %s Fetchable path", async (route) => {
  for (const name of ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS", "AUTH_SECRET", "VITEHUB_SECRET", "NUXT_APP_SECRET"]) vi.stubEnv(name, "")
  const env = { AUTH_APP_NAME: "Request Auth", VITEHUB_SECRET: "request-only-root-secret-at-least-32-bytes" }
  const options = vi.fn(({ env }: { env: Record<string, unknown> }) => ({
    appName: String(env.AUTH_APP_NAME),
    baseURL: "https://example.com",
    emailAndPassword: { enabled: true },
  }))
  const definition = defineAuth(options)
  setAuthRuntimeEnvResolver(event => event ? getStandardContext(event).runtime?.cloudflare?.env ?? {} : {}, definition)
  const requestWithBindings = (path: string, init?: RequestInit) => {
    const request = new Request(`https://example.com${path}`, init)
    Object.defineProperty(request, "~standard", { value: { vendor: "test", req: request, res: {}, runtime: { cloudflare: { env } } } })
    return request
  }
  const signUp = requestWithBindings("/api/auth/sign-up/email", {
    body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "passwordpassword" }),
    headers: { "content-type": "application/json", origin: "https://example.com" },
    method: "POST",
  })
  // Establish the session through an event, then check the same cookie through a native Request.
  const signedIn = await handleAuthRequest(definition, { "~standard": getStandardContext(signUp) })
  expect(signedIn.status).toBe(200)
  const cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
  options.mockClear()

  if (route === "Collection") {
    const collection = defineCollection(async () => [{ id: 1 }], { authorize: true, cursor: item => item.id, cursorSchema: v.number() })
    const handler = defineCollectionHandler(collection, { withAuthorization: (authorize, handle) => withAuthorization(authorize, handle, definition) })
    const response = await handler.fetch(requestWithBindings("/api/items", { headers: { cookie } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ items: [{ id: 1 }] })
  }
  else {
    const root = await mkdtemp(join(tmpdir(), "vitehub-fetchable-auth-"))
    try {
      const files = await writeConsoleAuthHandlers(root, { server: join(root, "console-auth.ts") })
      const source = (await readFile(files.middleware, "utf8")).replace(/^import .*\n/gm, "").replace("export default ", "").replace(/^export /gm, "")
      const middleware = new Function("definition", "input", "prepare", "withAuthorization", "toAuthRequest", "createAuthForRequest", "readConsoleSessionUser", `${source}\nreturn { checkConsoleAccess, readConsoleUser }`)(
        definition, { authorize: () => true }, async () => {}, withAuthorization, toAuthRequest, createAuthForRequest, readConsoleSessionUser,
      ) as { checkConsoleAccess: (event: ConsoleRequestEvent) => Promise<Response | undefined>, readConsoleUser: (request: Request) => ReturnType<typeof readConsoleSessionUser> }
      installConsoleAccess({ mode: "auth", check: middleware.checkConsoleAccess })
      const actorFile = await writeConsoleConnectionsActor(root, files.middleware)
      const actorSource = (await readFile(actorFile, "utf8")).replace(/^import .*\n/gm, "").replace("export default ", "return ")
      const actor = new Function("consoleConnectionsActor", "readConsoleUser", actorSource)(consoleConnectionsActor, middleware.readConsoleUser) as (request: Request) => Promise<string | Response>
      const request = requestWithBindings("/_vitehub/connections", { headers: { cookie } })
      const result = await actor(request)
      expect(result).toEqual(expect.stringMatching(/^user:/))
      // The generated session factory must also derive its secret from the same Request bindings.
      expect(createAuthForRequest(definition, request, undefined, { "~standard": getStandardContext(request) }).options.secret).toBe(await deriveViteHubSecret(env.VITEHUB_SECRET, "vitehub:auth"))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }
  expect(options).toHaveBeenCalled()
  for (const [context] of options.mock.calls) expect(context.env).toEqual(env)
})
