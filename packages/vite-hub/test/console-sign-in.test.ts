import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleSignInURL } from "../src/console/runtime/client/sign-in.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import consoleSignInMiddleware from "../src/console/runtime/server/sign-in.ts"
import { requestEvent } from "./console-event.ts"

const origin = "http://vitehub.local"
const unsafePages = ["/..//evil.example/sign-in", "/%2e%2e//evil.example/sign-in"]
const visit = (path: string) => (requestEvent(new Request(`${origin}${path}`, { headers: { accept: "text/html" } })))
const page = (signInPage: string) => ({
  document: { querySelector: () => ({ getAttribute: () => signInPage }) },
  location: new URL(`${origin}/portal/_vitehub/auth?tab=users`),
})

afterEach(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access")) })

describe("Console sign-in URL normalization", () => {
  it.each([...unsafePages, "/\\evil.example/sign-in"])("does not link to %s", (signInPage) => {
    expect(consoleSignInURL(page(signInPage))).toBeUndefined()
  })

  it("preserves the sign-in fragment in a client link", () => {
    expect(consoleSignInURL(page("/portal/?from=console#/sign-in"))).toBe("/portal/?from=console&redirect=%2Fportal%2F_vitehub%2Fauth%3Ftab%3Dusers#/sign-in")
  })
})

describe("Console sign-in middleware", () => {
  it("answers only the app Auth sign-in page and leaves other paths to the app", async () => {
    const signIn = vi.fn(async () => new Response("sign-in"))
    installConsoleAccess({ mode: "auth", check: async () => new Response(null, { status: 401 }), signIn })
    for (const path of ["/_vitehub", "/_vitehub/auth", "/_vitehub/sign-in/extra", "/sign-in"]) {
      await expect(consoleSignInMiddleware(visit(path)), path).resolves.toBeUndefined()
    }
    expect(signIn).not.toHaveBeenCalled()
    await expect((await consoleSignInMiddleware(visit("/portal/_vitehub/sign-in")))?.text()).resolves.toBe("sign-in")
  })

  it("does nothing without app Auth sign-in", async () => {
    installConsoleAccess({ mode: "auth", check: async () => new Response(null, { status: 401 }) })
    await expect(consoleSignInMiddleware(visit("/_vitehub/sign-in"))).resolves.toBeUndefined()
  })
})
