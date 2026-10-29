// @vitest-environment happy-dom
import type { HTMLElement, Window } from "happy-dom"
import { createApp, defineComponent, h } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(),
  requestConsole: mocks.request,
}))

vi.mock("@vite-hub/ui", async () => {
  const { defineComponent, h } = await import("vue")
  return {
    ChatMessage: defineComponent({
      props: { message: { required: true, type: Object } },
      setup: (props, { slots }) => () => h("div", { "data-slot": "message" }, [slots.header?.(), (props.message as { parts: Array<{ text: string }> }).parts[0]!.text, slots.actions?.()]),
    }),
  }
})
vi.mock("../src/console/runtime/components/console-frame.vue", async () => {
  const { defineComponent, h } = await import("vue")
  return { default: defineComponent({ setup: (_props, { slots }) => () => h("div", [slots.default?.(), slots.right?.()]) }) }
})
vi.mock("../src/console/runtime/components/console-search.vue", async () => {
  const { defineComponent, h } = await import("vue")
  return { default: defineComponent({ setup: (_props, { slots }) => () => h("div", [slots.default?.(), slots.right?.()]) }) }
})
vi.mock("../src/console/runtime/components/console-page-header.vue", async () => {
  const { defineComponent, h } = await import("vue")
  return { default: defineComponent({ setup: (_props, { slots }) => () => h("div", [slots.default?.(), slots.right?.()]) }) }
})
vi.mock("../src/console/runtime/components/console-status.vue", async () => {
  const { defineComponent, h } = await import("vue")
  return { default: defineComponent({ setup: (_props, { slots }) => () => h("div", [slots.default?.(), slots.right?.()]) }) }
})

import ConsoleChannels from "../src/console/runtime/components/console-channels.vue"

const data = Buffer.from("abc").toString("base64")
const retention = { durable: false, maxMessages: 100, mode: "provider-window", transcripts: false, ttlMs: 604_800_000, warning: "Transcripts are not durable." }

const answers: Record<string, unknown> = {
  "/api/c/channels": { channels: [{ agent: "support", channel: "telegram", conversations: true, provider: "telegram", retention }] },
  "/api/c/channels/threads": { threads: [{ invocationCount: 1, lastMessageAt: "2026-06-10T12:00:00.000Z", participants: ["Maxi"], thread: "telegram:1" }] },
  "/api/c/channels/conversation": {
    messages: [{
      attachments: [
        { name: "safe.pdf", url: "https://cdn.example.com/safe.pdf" },
        { name: "evil.pdf", url: "javascript:alert(1)" },
        { name: "data.html", url: "data:text/html,<b>x</b>" },
      ],
      at: "2026-06-10T12:00:00.000Z",
      author: { name: "Maxi" },
      id: "1",
      role: "user",
      source: "provider",
      text: "look",
    }],
    retention,
  },
  "/api/c/channels/export": {
    filename: "history.json",
    media: [{ base64: data, path: "media/0001-a.png" }, { base64: data, path: "media/0002-quoted.png" }],
    text: JSON.stringify({ messages: [{ attachments: [{ file: "media/0001-a.png", name: "a.png" }], id: "1", replyTo: { attachments: [{ file: "media/0002-quoted.png", name: "quoted.png" }], id: "0" } }] }),
  },
}

// SAFETY: This test runs in happy-dom, whose window is the global scope.
const page = () => globalThis as unknown as Pick<Window, "document">

const passthrough = defineComponent({ setup: (_props, { slots }) => () => h("div", [slots.default?.(), slots.right?.(), slots.body?.()]) })
const button = defineComponent({ props: { label: String, onClick: Function }, setup: props => () => h("button", { "data-button": props.label, onClick: props.onClick as never }, props.label) })

async function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ component: ConsoleChannels, name: "vitehub-console-channels", path: "/channels" }, { component: passthrough, name: "vitehub-console-invocation", path: "/agents/:agent/invocations/:invocation" }],
  })
  await router.push({ path: "/channels", query: { agent: "support", channel: "telegram", thread: "telegram:1" } })
  const { document } = page()
  const host = document.createElement("div")
  document.body.append(host)
  const app = createApp(() => h(ConsoleChannels, { agentsBase: "/api/a", channelsBase: "/api/c/channels", definitionsBase: "/api/d", kvBase: "/api/k", searchBase: "/api/s", sectionsBase: "/api/sec" }))
  app.use(router)
  for (const name of ["ConsoleFrame", "ConsoleSearch", "ConsolePageHeader", "UDashboardPanel", "UAlert", "UEmpty", "USkeleton", "UTooltip", "UIcon"]) app.component(name, passthrough)
  app.component("UButton", button)
  app.mount(host)
  await vi.waitFor(() => expect(host.querySelector("[data-slot=message], li")).not.toBeNull())
  return { host }
}

afterEach(() => {
  page().document.body.innerHTML = ""
  vi.restoreAllMocks()
  mocks.request.mockReset()
})

describe("Channels page", () => {
  it("links only http(s) attachments", async () => {
    mocks.request.mockImplementation(async (path: string) => answers[path])
    const { host } = await mountPage()
    await vi.waitFor(() => expect(host.textContent).toContain("evil.pdf"))
    const links = [...host.querySelectorAll("a")].map(link => link.getAttribute("href"))
    expect(links).toContain("https://cdn.example.com/safe.pdf")
    expect(links.some(href => href?.startsWith("javascript:") || href?.startsWith("data:"))).toBe(false)
    expect(host.textContent).toContain("data.html")
  })

  it("downloads the JSON archive with the data of every attachment, a quoted message too", async () => {
    mocks.request.mockImplementation(async (path: string) => answers[path])
    const blobs: Blob[] = []
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (blob: Blob) => { blobs.push(blob); return "blob:test" }, revokeObjectURL: () => {} }))
    const { host } = await mountPage()
    await vi.waitFor(() => expect(host.querySelector("[data-button=JSON]")).not.toBeNull())
    ;(host.querySelector("[data-button=JSON]") as unknown as HTMLElement).click()
    await vi.waitFor(() => expect(blobs).toHaveLength(1))
    const archive = JSON.parse(await blobs[0]!.text())
    expect(archive.messages[0].attachments[0]).toEqual({ data, name: "a.png" })
    expect(archive.messages[0].replyTo.attachments[0]).toEqual({ data, name: "quoted.png" })
    expect(mocks.request).toHaveBeenCalledWith("/api/c/channels/export", { query: { agent: "support", channel: "telegram", format: "json", media: "true", thread: "telegram:1" } })
  })
})
