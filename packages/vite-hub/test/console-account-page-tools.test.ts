import { readFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"

import { injectPageToolsLoader } from "@vite-hub/internal/runtime/page-tools"
import { viteHubPageToolsLoader as loader } from "@vite-hub/internal/runtime/page-tools-shared"

import { loadConsolePageTools } from "../src/console/runtime/client/page-tools.ts"

describe("page tools of the account Console page", () => {
  it("gets no loader from the server, so the page tools do not load next to the Console's boot", async () => {
    // A commenter's request has the hint, so the server adds the loader to a page without the page tools marker.
    const page = await readFile(new URL("../src/console/hosted/account.html", import.meta.url), "utf8")
    const response = injectPageToolsLoader(new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }))
    const html = await response.text()
    expect(html).not.toContain(loader)
    expect(html.match(/data-vitehub-page-tools/g)).toHaveLength(1)
  })

  it("loads the loader after the mount only with the hint of the page tools", async () => {
    const load = vi.fn(async () => undefined)
    expect(loadConsolePageTools("/", { search: "", cookie: "better-auth.session_token=abc" }, load)).toBeUndefined()
    expect(loadConsolePageTools("/", { search: "", cookie: "vitehub_session=1; vitehub-tools=0" }, load)).toBeUndefined()
    expect(load).not.toHaveBeenCalled()

    await loadConsolePageTools("/", { search: "", cookie: "vitehub_session=1" }, load)
    await loadConsolePageTools("/", { search: "", cookie: "vitehub-tools=1" }, load)
    await loadConsolePageTools("/portal/", { search: "?vitehub", cookie: "" }, load)
    expect(load.mock.calls).toEqual([[loader], [loader], [`/portal${loader}`]])
  })

  it("keeps the Console running when the loader fails", async () => {
    await expect(loadConsolePageTools("/", { search: "?vitehub", cookie: "" }, async () => { throw new TypeError("offline") })).resolves.toBeUndefined()
  })
})
