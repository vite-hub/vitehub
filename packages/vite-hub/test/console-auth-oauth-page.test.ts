import { runInNewContext } from "node:vm"
import { Window, type HTMLButtonElement, type HTMLElement } from "happy-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleAuthOAuthPage } from "../src/console/auth-oauth-page.ts"

const windows: Window[] = []
afterEach(() => { for (const window of windows.splice(0)) window.close() })

async function consentPage(scope: string) {
  const query = new URLSearchParams({ client_id: "executor", redirect_uri: "https://agent.example.com/callback", scope, sig: "signed" })
  for (const name of ["client_id", "redirect_uri", "scope"]) query.append("ba_param", name)
  const window = new Window({ url: `https://app.example.com/portal/_vitehub/sign-in?${query}` })
  windows.push(window)
  window.document.write(await consoleAuthOAuthPage({ providers: [], password: false }, "/portal/api/auth", "/portal/_vitehub").text())
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/get-session")) return Response.json({ user: { name: "Ada Lovelace", email: "ada@example.com" } })
    if (url.includes("/oauth2/public-client?")) return Response.json({ client_name: "Executor" })
    return Response.json({ success: true })
  })
  const reload = vi.fn()
  await runInNewContext(window.document.querySelector("script")!.textContent, {
    document: window.document,
    fetch,
    location: { search: window.location.search, host: window.location.host, reload },
    URL,
    URLSearchParams,
  })
  return { document: window.document, fetch, reload }
}

describe("OAuth consent document", () => {
  it.each([
    { scope: "", read: false, write: false, offline: false },
    { scope: "openid", read: false, write: false, offline: false },
    { scope: "vitehub:read", read: true, write: false, offline: false },
    { scope: "vitehub:write", read: false, write: true, offline: false },
    { scope: "vitehub:read vitehub:write", read: true, write: true, offline: false },
    { scope: "offline_access", read: false, write: false, offline: true },
    { scope: "vitehub:read vitehub:write offline_access", read: true, write: true, offline: true },
  ])("describes only the requested capabilities for '$scope'", async ({ scope, read, write, offline }) => {
    const { document } = await consentPage(scope)
    const grants = document.querySelector<HTMLElement>("#grants")!
    expect(grants.textContent.includes("Read data")).toBe(read)
    expect(grants.textContent.includes("Change, publish, and delete data")).toBe(write)
    expect(grants.textContent.includes("Stay connected")).toBe(offline)
    expect(grants.hidden).toBe(!read && !write && !offline)
    expect(document.querySelector("#text")!.textContent).toBe(read || write
      ? "It acts as you, with the Console sections you may use."
      : "No Console data access is requested.")
  })

  it("shows failed sign-out, enables retry, and reloads only after sign-out succeeds", async () => {
    const { document, fetch, reload } = await consentPage("vitehub:read")
    fetch.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
    const switchAccount = document.querySelector<HTMLButtonElement>("#switch")!
    switchAccount.click()
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("[role=alert]")!.hidden).toBe(false)
      expect(document.querySelector("[role=alert]")!.textContent).toBe("Sign-out did not finish. Try again.")
      expect([...document.querySelectorAll<HTMLButtonElement>("button")].every(button => !button.disabled)).toBe(true)
    })
    expect(reload).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenLastCalledWith("/portal/api/auth/sign-out", {
      body: "{}", credentials: "same-origin", headers: { "content-type": "application/json" }, method: "POST",
    })

    switchAccount.click()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect(document.querySelector<HTMLElement>("[role=alert]")!.hidden).toBe(true)
  })
})
