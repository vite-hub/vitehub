import { runInNewContext } from "node:vm"
import { Window, type HTMLButtonElement, type HTMLElement } from "happy-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleAuthOAuthPage } from "../src/console/auth-oauth-page.ts"

const windows: Window[] = []
afterEach(() => { for (const window of windows.splice(0)) window.close() })

async function consentPage(scope: string, options: { signedIn?: boolean, clientName?: boolean } = {}) {
  const { signedIn = true, clientName = true } = options
  const query = new URLSearchParams({ client_id: "executor", redirect_uri: "https://agent.example.com/callback", scope, sig: "signed" })
  for (const name of ["client_id", "redirect_uri", "scope"]) query.append("ba_param", name)
  const window = new Window({ url: `https://app.example.com/portal/_vitehub/sign-in?${query}` })
  windows.push(window)
  window.document.write(await consoleAuthOAuthPage({ providers: [], password: false }, "/portal/api/auth", "/portal/_vitehub").text())
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/get-session")) return Response.json(signedIn ? { user: { name: "Ada Lovelace", email: "ada@example.com" } } : null)
    // Better Auth answers 401 for a client lookup without a session.
    if (url.includes("/oauth2/public-client?")) return clientName && signedIn ? Response.json({ client_name: "Executor" }) : new Response(null, { status: 401 })
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

  it.each([
    { signedIn: false, clientName: false, heading: "Sign in to connect an agent" },
    { signedIn: true, clientName: false, heading: "Allow an agent to use app.example.com?" },
    { signedIn: true, clientName: true, heading: "Allow Executor to use app.example.com?" },
  ])("names the agent in the heading (signed in: $signedIn, name: $clientName)", async ({ signedIn, clientName, heading }) => {
    const { document } = await consentPage("vitehub:read", { signedIn, clientName })
    await vi.waitFor(() => expect(document.querySelector("h1")!.textContent).toBe(heading))
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

describe("passkey sign-in on the OAuth login step", () => {
  async function loginPage(passkey: boolean) {
    const query = new URLSearchParams({ client_id: "console", redirect_uri: "https://console.vitehub.dev/oauth/callback", scope: "vitehub:read vitehub:write", sig: "signed" })
    for (const name of ["client_id", "redirect_uri", "scope"]) query.append("ba_param", name)
    const window = new Window({ url: `https://app.example.com/_vitehub/sign-in?${query}` })
    windows.push(window)
    window.document.write(await consoleAuthOAuthPage({ providers: [], password: true, passkey }, "/api/auth", "/_vitehub/sign-in").text())
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.endsWith("/get-session")) return Response.json(null)
      if (url.includes("/oauth2/public-client?")) return new Response(null, { status: 401 })
      if (url.endsWith("/passkey/generate-authenticate-options")) return Response.json({ challenge: "AQID", allowCredentials: [{ id: "BAU", type: "public-key" }], rpId: "app.example.com" })
      if (url.endsWith("/passkey/verify-authentication")) return Response.json({ url: "https://console.vitehub.dev/oauth/callback?code=c", body: init?.body })
      return Response.json({})
    })
    const bytes = (...values: number[]) => new Uint8Array(values).buffer
    const get = vi.fn(async () => ({
      id: "BAU",
      rawId: bytes(4, 5),
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({}),
      response: { authenticatorData: bytes(1), clientDataJSON: bytes(2), signature: bytes(3), userHandle: bytes(9) },
    }))
    const assign = vi.fn()
    await runInNewContext(window.document.querySelector("script")!.textContent, {
      atob,
      btoa,
      document: window.document,
      fetch,
      location: { search: window.location.search, host: window.location.host, assign },
      navigator: { credentials: { get } },
      URL,
      URLSearchParams,
      window: { PublicKeyCredential: class {} },
    })
    return { document: window.document, fetch, get, assign }
  }

  it("offers a passkey only when the Auth has the passkey plugin", async () => {
    const without = await loginPage(false)
    await vi.waitFor(() => expect(without.document.querySelector("h1")!.textContent).toBe("Sign in to connect an agent"))
    expect([...without.document.querySelectorAll("button")].some(button => button.textContent === "Sign in with a passkey")).toBe(false)
    const { document } = await loginPage(true)
    await vi.waitFor(() => expect([...document.querySelectorAll("button")].some(button => button.textContent === "Sign in with a passkey")).toBe(true))
  })

  it("signs in with the passkey and the signed query, then follows the provider", async () => {
    const { document, fetch, get, assign } = await loginPage(true)
    let button: HTMLButtonElement | undefined
    await vi.waitFor(() => {
      button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent === "Sign in with a passkey")
      expect(button).toBeDefined()
    })
    button!.click()
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("https://console.vitehub.dev/oauth/callback?code=c"))
    expect(get).toHaveBeenCalledOnce()
    const verify = fetch.mock.calls.find(([url]) => url === "/api/auth/passkey/verify-authentication")!
    const body: unknown = JSON.parse(verify[1]!.body!)
    expect(body).toMatchObject({
      oauth_query: expect.stringContaining("sig=signed"),
      response: { id: "BAU", rawId: "BAU", type: "public-key", response: { authenticatorData: "AQ", clientDataJSON: "Ag", signature: "Aw", userHandle: "CQ" } },
    })
  })
})
