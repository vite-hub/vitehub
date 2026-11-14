
import { defineAuth } from "@vite-hub/auth"
import { handleAuthRequest, setAuthRuntimeEnvResolver, withAuthorization } from "@vite-hub/auth/internal/server"
import { getStandardContext } from "@vite-hub/runtime"
import { defineCollection } from "@vite-hub/source"
import { defineCollectionHandler } from "@vite-hub/source/server"
import * as v from "valibot"
import { afterEach, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllEnvs()
})

it("keeps request-local Auth bindings on the Collection Fetchable path", async () => {
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

  const collection = defineCollection(async () => [{ id: 1 }], { authorize: true, cursor: item => item.id, cursorSchema: v.number() })
  const handler = defineCollectionHandler(collection, { withAuthorization: (authorize, handle) => withAuthorization(authorize, handle, definition) })
  const response = await handler.fetch(requestWithBindings("/api/items", { headers: { cookie } }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ items: [{ id: 1 }] })
  expect(options).toHaveBeenCalled()
  for (const [context] of options.mock.calls) expect(context.env).toEqual(env)
})
