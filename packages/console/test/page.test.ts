import { scriptNonce } from "@vite-hub/internal/runtime/page-tools"
import { describe, expect, it } from "vitest"

import { consolePageBoot, consolePagePolicy, renderConsolePage } from "../src/page.ts"

const session = "__Secure-better-auth.session_token=abc"
const visit = (path: string, cookie?: string) => new Request(`https://console.example.com${path}`, cookie ? { headers: { cookie } } : {})

describe("consolePageBoot", () => {
  it("draws the sign-in page without a session, and the invitation page for every invitation", () => {
    expect(consolePageBoot(visit("/"))).toBe("sign-in")
    expect(consolePageBoot(visit("/team", "vitehub-console-view=app"))).toBe("sign-in")
    expect(consolePageBoot(visit("/invite/abc"))).toBe("invite")
    expect(consolePageBoot(visit("/invite/abc", session))).toBe("invite")
  })

  it("draws the team sidebar on its pages, and on the home path unless the last visit ended in an app", () => {
    expect(consolePageBoot(visit("/team", session))).toBe("shell")
    expect(consolePageBoot(visit("/settings/", "better-auth.session_token=abc"))).toBe("shell")
    expect(consolePageBoot(visit("/team-settings", session))).toBe("shell")
    expect(consolePageBoot(visit("/", session))).toBe("shell")
    expect(consolePageBoot(visit("/?app=1", `${session}; vitehub-console-view=shell`))).toBe("shell")
    expect(consolePageBoot(visit("/", `vitehub-console-view=app; ${session}`))).toBe("app")
    expect(consolePageBoot(visit("/", `${session}; vitehub-console-view=application`))).toBe("shell")
    expect(consolePageBoot(visit("/logs", session))).toBe("app")
  })
})

describe("renderConsolePage", () => {
  const html = '<div class="vitehub-account-boot" data-vitehub-boot="app" data-vitehub-page="">'

  it("marks the view and the sidebar row of the request", () => {
    expect(renderConsolePage(html, visit("/team", session))).toContain('data-vitehub-boot="shell" data-vitehub-page="team"')
    expect(renderConsolePage(html, visit("/team-settings", session))).toContain('data-vitehub-boot="shell" data-vitehub-page="team-settings"')
    expect(renderConsolePage(html, visit("/", session))).toContain('data-vitehub-boot="shell" data-vitehub-page=""')
    expect(renderConsolePage(html, visit("/"))).toContain('data-vitehub-boot="sign-in" data-vitehub-page=""')
  })
})

describe("consolePagePolicy", () => {
  it("gives each page a new script nonce that the page tools read, so their check is not blocked", () => {
    const first = consolePagePolicy()
    const nonce = scriptNonce(new Headers({ "content-security-policy": first }))
    expect(nonce).toMatch(/^[\w+/]{22}==$/)
    expect(first).toContain(`script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`)
    expect(scriptNonce(new Headers({ "content-security-policy": consolePagePolicy() }))).not.toBe(nonce)
  })
})
