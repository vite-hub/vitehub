// @vitest-environment happy-dom
import type { Document, HTMLElement } from "happy-dom"
import { createApp, defineComponent, h, nextTick, reactive } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

// The happy-dom environment provides the document. Browser types stay local to this test.
const document: Document = Reflect.get(globalThis, "document")

const route = reactive({ name: "vitehub-console-usage", query: {} as Record<string, string> })
const replace = vi.fn(async ({ query }: { query: Record<string, string | undefined> }) => {
  route.query = Object.fromEntries(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined))
})
const responses: unknown[] = []
const requests: Array<Record<string, string> | undefined> = []

vi.mock("vue-router", () => ({ useRoute: () => route, useRouter: () => ({ replace }) }))
vi.mock("../src/console/runtime/client/request", () => ({
  requestConsole: async (base: string, options?: { query?: Record<string, string> }) => {
    if (base.endsWith("/status")) return { agents: [] }
    requests.push(options?.query)
    return responses.shift()
  },
}))

import Usage from "../src/console/runtime/components/console-usage.vue"

function totals(overrides: Record<string, unknown> = {}) {
  return {
    cacheWriteTokens: 0, cacheWriteTokensAvailable: true, cachedInputTokens: 0, cachedInputTokensAvailable: true,
    costAvailable: true, costEstimated: false, costUsd: "0", pricedInvocations: 0, inputTokens: 0,
    inputTokensAvailable: true, invocations: 0, invocationsAvailable: true, outputTokens: 0, outputTokensAvailable: true,
    reasoningTokens: 0, reasoningTokensAvailable: true, totalTokens: 0, totalTokensAvailable: true,
    ...overrides,
  }
}

function summary(overrides: Record<string, unknown> = {}) {
  const missing = totals({ costAvailable: false, invocations: 1, totalTokens: 1_200, totalTokensAvailable: true })
  return {
    available: true, costSupported: true, agents: [], sessions: [], sessionCount: 0, runs: [], expensive: [],
    buckets: [
      { ...totals(), models: [], start: "2026-10-11T00:00:00.000Z" },
      { ...missing, models: [], start: "2026-10-12T00:00:00.000Z" },
    ],
    costAvailable: false, from: "2026-10-11T00:00:00.000Z", generatedAt: "2026-10-13T00:00:00.000Z", models: [],
    partial: true, resolution: "day", to: "2026-10-13T00:00:00.000Z", totals: missing,
    ...overrides,
  }
}

function session(id: string) {
  return { id, agent: "bot", status: "completed", at: "2026-10-12T14:05:09.000Z", models: [], partial: false, totals: totals() }
}

const passthrough = (tag: string) => defineComponent({ setup(_props, { attrs, slots }) { return () => h(tag, attrs, slots.default?.()) } })
const stubs = {
  RouterLink: passthrough("a"),
  UAlert: passthrough("div"),
  UBadge: passthrough("span"),
  UIcon: defineComponent({ setup(_props, { attrs }) { return () => h("span", attrs) } }),
  UInput: defineComponent({ setup(_props, { attrs }) { return () => h("input", attrs) } }),
  USelect: defineComponent({ setup(_props, { attrs }) { return () => h("div", attrs) } }),
  USlideover: defineComponent({
    props: { open: { default: false, type: Boolean }, title: { default: "", type: String } },
    setup(props, { slots }) { return () => (props.open ? h("div", { "data-test": "slideover", "data-title": props.title }, slots.body?.()) : null) },
  }),
  UTooltip: passthrough("div"),
  UButton: defineComponent({
    props: { label: { default: undefined, type: String } },
    emits: ["click"],
    setup(props, { attrs, emit, slots }) { return () => h("button", { ...attrs, type: "button", onClick: () => emit("click") }, slots.default?.() ?? props.label) },
  }),
  UEmpty: defineComponent({
    props: { actions: { default: () => [], type: Array }, description: { default: "", type: String }, title: { default: "", type: String } },
    setup(props, { attrs }) {
      return () => h("div", { ...attrs, "data-test": "empty" }, [
        h("p", props.title),
        h("p", props.description),
        ...props.actions.map(action => h("button", { onClick: (action as { onClick: () => void }).onClick, type: "button" }, (action as { label: string }).label)),
      ])
    },
  }),
  UDashboardPanel: defineComponent({ setup(_props, { slots }) { return () => h("div", [slots.header?.(), slots.body?.()]) } }),
  UDashboardNavbar: defineComponent({ setup(_props, { slots }) { return () => h("header", slots.right?.()) } }),
  // The stub renders the selected panel. Nuxt UI renders the tab and tabpanel roles, which the Console only configures.
  UTabs: defineComponent({
    props: { items: { required: true, type: Array }, modelValue: { required: true, type: String } },
    emits: ["update:modelValue"],
    setup(props, { emit, slots }) {
      return () => h("div", [
        ...(props.items as Array<{ label: string, slot: string, value: string }>).map(item =>
          h("button", { "data-tab": item.value, onClick: () => emit("update:modelValue", item.value), type: "button" }, item.label)),
        slots[props.modelValue]?.(),
      ])
    },
  }),
}

async function mount() {
  const root = document.createElement("div")
  document.body.append(root)
  const app = createApp(Usage, { base: "/api/_vitehub/console/usage" })
  for (const [name, component] of Object.entries(stubs)) app.component(name, component)
  app.mount(root)
  await vi.waitFor(() => expect(root.querySelector("[data-tab]")).not.toBeNull())
  await vi.waitFor(() => expect(root.textContent).not.toContain("Loading session history"))
  return { app, root }
}

afterEach(() => {
  responses.length = 0
  requests.length = 0
  route.query = {}
  document.body.innerHTML = ""
})

describe("Console Usage page", () => {
  it("names the chart, keeps plotted periods out of the tab order, and lists values in a data table", async () => {
    responses.push(summary({ totals: totals({ costUsd: "0.5", invocations: 1, pricedInvocations: 1, totalTokens: 10 }), buckets: [
      { ...totals(), models: [], start: "2026-10-11T00:00:00.000Z" },
      { ...totals({ costUsd: "0.5", invocations: 1, pricedInvocations: 1 }), models: [], start: "2026-10-12T00:00:00.000Z" },
    ] }))
    const { app, root } = await mount()
    try {
      const chart = root.querySelector("svg[role=img]")
      expect(document.getElementById(chart!.getAttribute("aria-labelledby")!)?.textContent).toBe("Daily cost")
      expect(document.getElementById(chart!.getAttribute("aria-describedby")!)?.textContent).toContain("Peak $0.50 on Oct 12")
      expect(chart!.parentElement!.querySelectorAll("button, [tabindex]")).toHaveLength(0)
      const rows = [...root.querySelectorAll("[data-slot=usage-chart-data] tbody tr")].map(row => row.textContent)
      expect(rows).toEqual(["Oct 11$0.00", "Oct 12$0.50"])
    }
    finally { app.unmount() }
  })

  it("shows unavailable cost as a distinct state with a token alternative, not as a $0.00 axis", async () => {
    responses.push(summary())
    const { app, root } = await mount()
    try {
      expect(root.querySelector("svg[role=img]")).toBeNull()
      const empty = root.querySelector("[data-slot=usage-chart-empty]")
      expect(empty?.getAttribute("data-state")).toBe("unavailable")
      expect(empty?.textContent).toContain("Cost is unavailable for this period")
      expect(empty?.textContent).not.toContain("$")
      // A day without sessions is a real zero. A day with sessions but no cost evidence is unknown.
      const rows = [...root.querySelectorAll("[data-slot=usage-chart-data] tbody tr")].map(row => row.textContent)
      expect(rows).toEqual(["Oct 11$0.00", "Oct 12Unavailable"])
      ;[...empty!.querySelectorAll("button")].find(button => button.textContent === "Show tokens")!.click()
      await nextTick()
      expect(root.querySelector("svg[role=img]")).not.toBeNull()
    }
    finally { app.unmount() }
  })

  it("offers to clear filters when no session matches, also on the Overview", async () => {
    route.query = { search: "nothing", status: "failed" }
    responses.push(summary({ available: false, totals: totals(), buckets: [] }), summary())
    const { app, root } = await mount()
    try {
      const empty = root.querySelector("[data-usage-empty=no-match]")
      expect(empty?.textContent).toContain("No sessions match these filters")
      ;[...empty!.querySelectorAll("button")].find(button => button.textContent === "Clear filters")!.click()
      expect(replace).toHaveBeenLastCalledWith({ query: {} })
      await vi.waitFor(() => expect(requests.at(-1)).toEqual({ window: "30d" }))
    }
    finally { app.unmount() }
  })

  it("shows minute timestamps and moves focus to the history heading after a page change", async () => {
    responses.push(
      summary({ cursor: "next", sessionCount: 2, sessions: [session("first")] }),
      summary({ sessionCount: 2, sessions: [session("second")] }),
    )
    const { app, root } = await mount()
    try {
      root.querySelector<HTMLElement>("[data-tab=sessions]")!.click()
      await nextTick()
      const time = root.querySelector("time")!
      expect(time.textContent).toMatch(/^Oct 12, \d{1,2}:\d{2} [AP]M$/)
      expect(time.getAttribute("title")).toMatch(/2026 at \d{1,2}:\d{2}:\d{2} [AP]M/)
      const heading = root.querySelector<HTMLElement>("#session-history-heading")!
      heading.scrollIntoView = vi.fn()
      root.querySelector<HTMLElement>("button[aria-label='Next history page']")!.click()
      await vi.waitFor(() => expect(document.activeElement).toBe(heading))
      expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: "start" })
      expect(requests.at(-1)).toMatchObject({ cursor: "next" })
      expect(root.textContent).toContain("second")
    }
    finally { app.unmount() }
  })
})

function modelTotals(model: string, overrides: Record<string, unknown> = {}) {
  return { ...totals(overrides), model }
}

describe("Console Usage model detail", () => {
  it("charts one model with zero for complete periods and unavailable for periods without evidence", async () => {
    const sonnet = modelTotals("sonnet", { invocations: 1, totalTokens: 40 })
    responses.push(summary({
      costSupported: false,
      models: [sonnet],
      totals: totals({ invocations: 3, totalTokens: 40, totalTokensAvailable: false }),
      buckets: [
        { ...totals({ invocations: 1, totalTokens: 40 }), models: [sonnet], start: "2026-10-11T00:00:00.000Z" },
        { ...totals({ invocations: 1, totalTokens: 9 }), models: [modelTotals("haiku", { invocations: 1, totalTokens: 9 })], start: "2026-10-12T00:00:00.000Z" },
        { ...totals({ invocations: 1, totalTokensAvailable: false }), models: [], start: "2026-10-13T00:00:00.000Z" },
      ],
    }))
    const { app, root } = await mount()
    try {
      root.querySelector<HTMLElement>("button[aria-label='sonnet usage details']")!.click()
      await nextTick()
      const detail = root.querySelector("[data-slot=usage-model-detail]")!
      const chart = detail.querySelector("svg[role=img]")!
      expect(document.getElementById(chart.getAttribute("aria-labelledby")!)?.textContent).toBe("sonnet daily tokens")
      expect(detail.textContent).toContain("UTC days")
      const rows = [...detail.querySelectorAll("[data-slot=usage-chart-data] tbody tr")].map(row => row.textContent)
      expect(rows).toEqual(["Oct 1140", "Oct 120", "Oct 13Unavailable"])
      expect(detail.querySelector("[data-slot=usage-chart-data] th")?.textContent).toBe("Period (UTC)")
    }
    finally { app.unmount() }
  })
})

describe("Console Usage URL state", () => {
  it("restores section, metric, and breakdown from the query and keeps filters when they change", async () => {
    route.query = { breakdown: "time", metric: "tokens", search: "deploy", section: "sessions" }
    responses.push(summary({ sessions: [session("first")], sessionCount: 1 }))
    const { app, root } = await mount()
    try {
      expect(root.querySelector("#session-history-heading")).not.toBeNull()
      const requestCount = requests.length
      root.querySelector<HTMLElement>("[data-tab=overview]")!.click()
      expect(replace).toHaveBeenLastCalledWith({ query: { breakdown: "time", metric: "tokens", search: "deploy", section: undefined } })
      await nextTick()
      // The explicit token choice stays, although the Agents record cost.
      expect(root.querySelector("h2")?.textContent).toBe("Daily tokens")
      expect(root.querySelector("[aria-label='Usage breakdown'] [aria-pressed=true]")?.textContent).toBe("Day")
      ;[...root.querySelectorAll<HTMLElement>("[aria-label='Usage metric'] button")].find(button => button.textContent === "Cost")!.click()
      expect(replace).toHaveBeenLastCalledWith({ query: { breakdown: "time", metric: "cost", search: "deploy" } })
      // A view change does not load the summary again.
      expect(requests).toHaveLength(requestCount)
    }
    finally { app.unmount() }
  })

  it("ignores unknown query values and shows tokens when cost is not supported", async () => {
    route.query = { breakdown: "agent", metric: "cost", section: "settings" }
    responses.push(summary({ costSupported: false }))
    const { app, root } = await mount()
    try {
      expect(root.querySelector("[aria-label='Usage metric']")?.textContent).toBe("Tokens")
      expect(root.querySelector("h2")?.textContent).toBe("Daily tokens")
      expect(root.querySelector("[aria-label='Usage breakdown'] [aria-pressed=true]")?.textContent).toBe("Model")
    }
    finally { app.unmount() }
  })

  it("starts history from the first page when a filter changes and keeps the section", async () => {
    route.query = { section: "sessions" }
    responses.push(
      summary({ cursor: "next", sessionCount: 2, sessions: [session("first")] }),
      summary({ sessionCount: 2, sessions: [session("second")] }),
      summary({ sessionCount: 1, sessions: [session("failed")] }),
    )
    const { app, root } = await mount()
    try {
      root.querySelector<HTMLElement>("button[aria-label='Next history page']")!.click()
      await vi.waitFor(() => expect(root.textContent).toContain("second"))
      route.query = { ...route.query, status: "failed" }
      await vi.waitFor(() => expect(root.textContent).toContain("failed"))
      expect(requests.at(-1)).toEqual({ status: "failed", window: "30d" })
      expect(root.querySelector("#session-history-heading")).not.toBeNull()
      expect(root.querySelector("button[aria-label='Previous history page']")?.hasAttribute("disabled")).toBe(true)
    }
    finally { app.unmount() }
  })
})
