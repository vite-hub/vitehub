// @vitest-environment happy-dom
import { Window } from "happy-dom"
import { createApp, defineComponent, h, nextTick } from "vue"
import { afterEach, expect, it, vi } from "vitest"

import ConsoleConnect from "../src/console/runtime/components/console-connect.vue"
import { ConsoleNetworkError, ConsoleRequestError, requestConsole } from "../src/console/runtime/client/request.ts"
import { loadConsoleNavigation } from "../src/console/runtime/client/sections.ts"

vi.mock("../src/console/runtime/client/request.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request.ts")>(),
  requestConsole: vi.fn(),
}))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: { render: () => null } }))
vi.mock("../src/console/runtime/components/console-section-icon.vue", () => ({ default: { render: () => null } }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(requestConsole).mockReset()
})

function mountPage(sectionsBase: string) {
  const window = new Window({ url: "https://app.example.com/_vitehub/connect" })
  vi.stubGlobal("window", window)
  vi.stubGlobal("document", window.document)
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
  const app = createApp({ render: () => h(ConsoleConnect, { agentsBase: "", definitionsBase: "", kvBase: "", searchBase: "", sectionsBase }) })
  app.component("UDashboardPanel", defineComponent({ setup: (_, { slots }) => () => h("div", [slots.header?.(), slots.body?.()]) }))
  app.component("UDashboardNavbar", defineComponent({ setup: (_, { slots }) => () => h("div", [slots.title?.(), slots.right?.()]) }))
  app.component("UButton", defineComponent({ setup: (_, { attrs }) => () => h("button", attrs) }))
  app.component("RouterLink", defineComponent({ setup: (_, { slots }) => () => h("a", slots.default?.()) }))
  app.component("UIcon", defineComponent({ render: () => h("i") }))
  app.component("USkeleton", defineComponent({ render: () => h("div", { "data-loading": "" }) }))
  app.component("UTooltip", defineComponent({ setup: (_, { slots }) => () => slots.default?.() }))
  const root = window.document.createElement("div")
  app.mount(root)
  return { app, root }
}

it("recovers the setup and section list when the rail retries a failed navigation request", async () => {
  const base = "/recover/api/_vitehub/console/sections"
  vi.mocked(requestConsole).mockRejectedValueOnce(new ConsoleNetworkError(new TypeError("connection dropped")))
  const { app, root } = mountPage(base)
  try {
    await expect(loadConsoleNavigation(base)).resolves.toBeUndefined()
    await nextTick()
    expect(root.querySelectorAll("[data-loading]")).toHaveLength(0)
    expect(root.textContent).toContain("Could not load agent setup")
    expect(root.querySelector('button[label="Try again"]')).not.toBeNull()

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

it.each([true, false])("recovers from a signed-out session with a sign-in page: %s", async (hasSignInPage) => {
  const base = `/signed-out-${hasSignInPage}/api/_vitehub/console/sections`
  vi.mocked(requestConsole).mockRejectedValue(new ConsoleRequestError(401))
  const { app, root } = mountPage(base)
  if (hasSignInPage) {
    const meta = document.createElement("meta")
    meta.name = "vitehub-console-sign-in"
    meta.content = "/sign-in"
    document.head.append(meta)
  }
  try {
    await loadConsoleNavigation(base)
    await nextTick()
    expect(root.textContent).toContain("Sign in to connect an agent")
    expect(root.querySelectorAll("[data-loading]")).toHaveLength(0)
    expect(root.textContent).not.toContain("Your agent opens a sign-in page")
    const signIn = root.querySelector('button[label="Sign in again"]')
    expect(signIn).not.toBeNull()
    if (hasSignInPage) expect(signIn?.getAttribute("to")).toBe("/sign-in?redirect=%2F_vitehub%2Fconnect")

    const checkAgain = root.querySelector<HTMLButtonElement>('button[label="Check again"]')
    expect(checkAgain).not.toBeNull()
    checkAgain!.click()
    await loadConsoleNavigation(base)
    await nextTick()
    expect(root.textContent).toContain("Sign in to connect an agent")

    vi.mocked(requestConsole).mockResolvedValue({ auth: true, sections: ["kv"] })
    checkAgain!.click()
    await loadConsoleNavigation(base)
    await nextTick()
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(root.querySelectorAll("[role=tab]")).toHaveLength(4)
    expect(root.textContent).toContain("Your agent opens a sign-in page")
    expect(root.querySelector(".vitehub-console__connect-section")?.textContent).toContain("KV")
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
