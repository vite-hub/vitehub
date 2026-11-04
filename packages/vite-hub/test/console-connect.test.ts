// @vitest-environment happy-dom
import { Window } from "happy-dom"
import { createApp, defineComponent, h, nextTick } from "vue"
import { afterEach, expect, it, vi } from "vitest"

import ConsoleConnect from "../src/console/runtime/components/console-connect.vue"
import { requestConsole } from "../src/console/runtime/client/request.ts"
import { loadConsoleNavigation } from "../src/console/runtime/client/sections.ts"

vi.mock("../src/console/runtime/client/request.ts", () => ({ requestConsole: vi.fn() }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: { render: () => null } }))
vi.mock("../src/console/runtime/components/console-section-icon.vue", () => ({ default: { render: () => null } }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(requestConsole).mockReset()
})

function mountPage(sectionsBase: string) {
  const window = new Window({ url: "https://app.example.com/_vitehub/connect" })
  vi.stubGlobal("window", window)
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
  const app = createApp({ render: () => h(ConsoleConnect, { agentsBase: "", definitionsBase: "", kvBase: "", searchBase: "", sectionsBase }) })
  app.component("UDashboardPanel", defineComponent({ setup: (_, { slots }) => () => h("div", [slots.header?.(), slots.body?.()]) }))
  app.component("UDashboardNavbar", defineComponent({ setup: (_, { slots }) => () => h("div", [slots.title?.(), slots.right?.()]) }))
  app.component("UButton", defineComponent({ setup: (_, { attrs }) => () => h("button", attrs) }))
  app.component("RouterLink", defineComponent({ setup: (_, { slots }) => () => h("a", slots.default?.()) }))
  app.component("UIcon", defineComponent({ render: () => h("i") }))
  app.component("USkeleton", defineComponent({ render: () => h("div", { "data-loading": "" }) }))
  const root = window.document.createElement("div")
  app.mount(root)
  return { app, root }
}

it("recovers the setup and section list when the rail retries a failed navigation request", async () => {
  const base = "/recover/api/_vitehub/console/sections"
  vi.mocked(requestConsole).mockRejectedValueOnce(new TypeError("connection dropped"))
  const { app, root } = mountPage(base)
  try {
    await expect(loadConsoleNavigation(base)).resolves.toBeUndefined()
    await nextTick()
    expect(root.querySelectorAll("[data-loading]")).toHaveLength(2)

    vi.mocked(requestConsole).mockResolvedValue({ auth: "cloudflare-access", sections: ["kv"], readOnly: ["kv"] })
    await loadConsoleNavigation(base)
    await nextTick()
    expect(root.querySelectorAll("[data-loading]")).toHaveLength(0)
    expect([...root.querySelectorAll("[role=tab]")].map(tab => tab.textContent?.trim())).toEqual(["Claude Code", "Codex"])
    expect(root.textContent).toContain("Service Auth policy")
    expect(root.textContent).toContain("CF_ACCESS_CLIENT_SECRET")
    expect(root.querySelector(".vitehub-console__connect-section")?.textContent).toContain("Read only")
  }
  finally {
    app.unmount()
  }
})

it("explains production access without promising loopback protection when sign-in is disabled", async () => {
  const base = "/open/api/_vitehub/console/sections"
  vi.mocked(requestConsole).mockResolvedValue({ auth: false, sections: [] })
  const { app, root } = mountPage(base)
  try {
    await loadConsoleNavigation(base)
    await nextTick()
    expect(root.textContent).toContain("This Console has no sign-in")
    expect(root.textContent).toContain("in production, anyone who can reach it")
    expect(root.textContent).toContain("console.authorize")
    expect(root.textContent).not.toContain("answers only agents on this machine")
  }
  finally {
    app.unmount()
  }
})
