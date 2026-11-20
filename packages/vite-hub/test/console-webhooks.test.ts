import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRenderer, nextTick, ssrContextKey } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { describeViteHubConsoleSection, readViteHubConsoleSection } from "@vite-hub/internal/console"
import { webhooksConsoleSection } from "@vite-hub/webhooks/vite"

import { discoverConsoleBuildCatalog, withConsoleDocumentEditorSections } from "../src/console/build.ts"
import { parseConsoleContributedSection, parseConsoleSectionContent } from "../src/console/runtime/definitions.ts"
import { installConsoleDefinitions } from "../src/console/runtime/server/definitions.ts"
import { resolveConsoleSectionGroup } from "../src/console/runtime/sections.ts"
import { ConsoleRequestError } from "../src/console/runtime/client/request.ts"
import { canRedeliverDelivery, canRedeliverWebhook, deliveryMemberEndpoint, memberEndpointOwner, memberEndpointResult, missingWebhookVariables, webhookCountdown, webhookDebounceLabel, webhookLastResult, webhookStateStatus } from "../src/console/runtime/client/webhooks.ts"

import type { Component } from "vue"
import type { ConsoleMemberEndpoint, ConsoleWebhook, ConsoleWebhookDelivery } from "../src/console/runtime/client/webhooks.ts"

const mocks = vi.hoisted(() => ({ operation: vi.fn(), toast: vi.fn() }))
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(),
  requestConsoleOperation: mocks.operation,
}))
vi.mock("../src/console/runtime/client/read-only", () => ({ isConsoleSectionReadOnly: async () => false }))
vi.mock("../src/console/runtime/client/toast", () => ({ useConsoleToast: () => ({ error: mocks.toast }) }))
vi.mock("@vite-hub/ui", () => ({ Status: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))

import Webhooks from "../src/console/runtime/components/console-webhooks.vue"

const minute = 60_000

const t3: ConsoleWebhook = { debounceMs: 30 * minute, host: "t3.example.com", name: "t3", secret: "T3_WEBHOOK_SECRET", secretSet: true, signature: "github", url: "T3_WEBHOOK_URL", urlSet: true }

function member(fields: Partial<ConsoleMemberEndpoint> & Pick<ConsoleMemberEndpoint, "id" | "owner">): ConsoleMemberEndpoint {
  return { address: null, agent: "t3", createdAt: 0, disabledAt: null, disabledBy: null, host: "relay.t3.codes", kind: "url", last: null, mine: false, name: "Launch plan thread", ownerName: null, updatedAt: 0, ...fields }
}

const ana = member({ id: "whe_ana", owner: "user_ana", ownerName: "Ana Ruiz", last: { at: 5, error: null, failures: 0, state: "sent", status: 202 } })
const tom = member({ id: "whe_tom", mine: true, owner: "user_tom", ownerName: "Tom Becker", last: { at: 7, error: "HTTP 401", failures: 3, state: "dead", status: 401 } })

function delivery(fields: Partial<ConsoleWebhookDelivery> & Pick<ConsoleWebhookDelivery, "id" | "state">): ConsoleWebhookDelivery {
  return { attempts: 0, body: {}, count: 1, createdAt: 0, dueAt: 0, event: "comments.created", key: null, lastError: null, lastStatus: null, sentAt: null, updatedAt: 0, webhook: "t3", ...fields }
}

describe("Webhooks section helpers", () => {
  it("counts down to a pending delivery", () => {
    const now = Date.UTC(2026, 10, 17, 12)
    expect(webhookCountdown(now + 21 * minute, now)).toBe("fires in 21 min")
    expect(webhookCountdown(now + 20 * minute + 1, now)).toBe("fires in 21 min")
    expect(webhookCountdown(now + 42_000, now)).toBe("fires in 42 s")
    expect(webhookCountdown(now + 65 * minute, now)).toBe("fires in 1 h 5 min")
    expect(webhookCountdown(now + 120 * minute, now)).toBe("fires in 2 h")
    expect(webhookCountdown(now, now)).toBe("due now")
    expect(webhookCountdown(now - 5_000, now)).toBe("due now")
  })

  it("names a debounce in words", () => {
    expect(webhookDebounceLabel(0)).toBe("No debounce")
    expect(webhookDebounceLabel(1_000)).toBe("1 s debounce")
    expect(webhookDebounceLabel(30 * minute)).toBe("30 min debounce")
    expect(webhookDebounceLabel(90 * minute)).toBe("1 h 30 min debounce")
  })

  it("shows the result of the last attempt", () => {
    expect(webhookLastResult({ attempts: 4, lastError: "The receiver answered 502.", lastStatus: 502 })).toBe("HTTP 502")
    expect(webhookLastResult({ attempts: 1, lastError: "T3_WEBHOOK_SECRET is not set.", lastStatus: null })).toBe("T3_WEBHOOK_SECRET is not set.")
    expect(webhookLastResult({ attempts: 1, lastError: null, lastStatus: null })).toBe("No answer")
    expect(webhookLastResult({ attempts: 0, lastError: null, lastStatus: null })).toBe("No attempt")
  })

  it("redelivers only a finished delivery, and colors each state", () => {
    expect(["pending", "sending", "sent", "dead", "cancelled"].filter(state => canRedeliverWebhook(state as ConsoleWebhookDelivery["state"]))).toEqual(["sent", "dead", "cancelled"])
    expect(webhookStateStatus("dead")).toEqual({ label: "Dead", tone: "error" })
    expect(webhookStateStatus("sent")).toEqual({ label: "Sent", tone: "success" })
    expect(missingWebhookVariables({ ...t3, secretSet: false })).toEqual(["T3_WEBHOOK_SECRET"])
  })

  it("names the last result of a member endpoint", () => {
    expect(memberEndpointResult(ana)).toEqual({ at: 5, label: "202", tone: "success" })
    expect(memberEndpointResult(tom)).toEqual({ at: 7, label: "401, 3 in a row", tone: "error" })
    expect(memberEndpointResult({ ...tom, last: { at: 7, error: "HTTP 401", failures: 1, state: "dead", status: 401 } }).label).toBe("401")
    expect(memberEndpointResult({ ...ana, kind: "inbox", last: { at: 9, error: null, failures: 0, state: "sent", status: null } })).toEqual({ at: 9, label: "In the inbox", tone: "info" })
    expect(memberEndpointResult({ ...ana, disabledAt: 11, disabledBy: "Ana" })).toEqual({ at: 11, label: "Disabled by Ana", tone: "neutral" })
    expect(memberEndpointResult({ ...ana, last: null })).toEqual({ label: "No sends yet", tone: "neutral" })
    expect(memberEndpointOwner({ owner: "user_sam", ownerName: null })).toBe("user_sam")
  })

  it("offers Redeliver of a member delivery only to its owner", () => {
    const toAna = delivery({ id: "whd_ana", state: "dead", webhook: "@whe_ana" })
    const toTom = delivery({ id: "whd_tom", state: "dead", webhook: "@whe_tom" })
    expect(deliveryMemberEndpoint(toTom, [ana, tom])).toBe(tom)
    expect(deliveryMemberEndpoint(delivery({ id: "whd_t3", state: "dead" }), [ana, tom])).toBeUndefined()
    expect(canRedeliverDelivery(toAna, [ana, tom])).toBe(false)
    expect(canRedeliverDelivery(toTom, [ana, tom])).toBe(true)
    expect(canRedeliverDelivery({ ...toTom, state: "pending" }, [ana, tom])).toBe(false)
    expect(canRedeliverDelivery(delivery({ id: "whd_gone", state: "dead", webhook: "@whe_gone" }), [ana, tom])).toBe(false)
    expect(canRedeliverDelivery(delivery({ id: "whd_t3", state: "sent" }), [])).toBe(true)
  })
})

describe("Webhooks Console section", () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  })

  it("comes from the owner package with a webhooks view and no build-time data", async () => {
    const descriptor = describeViteHubConsoleSection(webhooksConsoleSection)
    expect(descriptor).toMatchObject({ icon: "i-vitehub-webhooks", id: "webhooks", label: "Webhooks", view: { kind: "webhooks" } })
    expect(parseConsoleContributedSection(JSON.parse(JSON.stringify(descriptor)))).toEqual(descriptor)
    expect(await readViteHubConsoleSection(webhooksConsoleSection, undefined)).toEqual({ kind: "webhooks" })
    expect(parseConsoleSectionContent({ kind: "webhooks", section: "webhooks" }, "webhooks")).toEqual({ kind: "webhooks" })
    expect(installConsoleDefinitions("/app", { webhooks: { kind: "webhooks" } }, [descriptor]).content.webhooks).toEqual({ kind: "webhooks" })
    expect(resolveConsoleSectionGroup("webhooks")).toBe("runtime")
  })

  it("turns on when the app has server/webhooks/", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-webhooks-"))
    roots.push(root)
    await mkdir(join(root, "server"), { recursive: true })
    const discover = () => discoverConsoleBuildCatalog({ discoveryRoot: root, plugins: [], projectRoot: root, sections: ["env"] })
    expect(withConsoleDocumentEditorSections(["env"], await discover())).toEqual(["env"])
    await mkdir(join(root, "server", "webhooks"))
    await writeFile(join(root, "server", "webhooks", "t3.ts"), "export default {}\n")
    const catalog = await discover()
    expect(withConsoleDocumentEditorSections(["env"], catalog)).toContain("webhooks")
    expect(catalog.content.webhooks).toEqual({ kind: "webhooks" })
    expect(catalog.sectionOverrides?.webhooks).toEqual(describeViteHubConsoleSection(webhooksConsoleSection))
  })

  it("turns on when a plugin uses member endpoints, without server/webhooks/", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-members-"))
    roots.push(root)
    const send = { name: "fixture-send", vitehub: { webhooks: { memberEndpoints: true, reason: "Sends waiting comments to each member's agent." } } }
    const catalog = await discoverConsoleBuildCatalog({ discoveryRoot: root, plugins: [send], projectRoot: root, sections: ["env"] })
    expect(withConsoleDocumentEditorSections(["env"], catalog)).toContain("webhooks")
    expect(catalog.content.webhooks).toEqual({ kind: "webhooks" })
    const off = { name: "fixture-send", vitehub: { webhooks: () => undefined } }
    expect(withConsoleDocumentEditorSections(["env"], await discoverConsoleBuildCatalog({ discoveryRoot: root, plugins: [off], projectRoot: root, sections: ["env"] }))).toEqual(["env"])
  })

  it("keeps the playground section equal to the owner section", async () => {
    const { playgroundWebhooksSection } = await vi.importActual<{ playgroundWebhooksSection: unknown }>("../../../playground/console/sections.ts")
    expect(JSON.parse(JSON.stringify(playgroundWebhooksSection))).toEqual(describeViteHubConsoleSection(webhooksConsoleSection))
  })
})

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

interface WebhooksState {
  canRedeliver: (entry: ConsoleWebhookDelivery) => boolean
  canSendNow: (entry: ConsoleWebhookDelivery) => boolean
  cancelling: ConsoleWebhookDelivery | undefined
  chooseOwner: (value: unknown) => void
  deliveryTarget: (entry: ConsoleWebhookDelivery) => string
  memberEndpoints: ConsoleMemberEndpoint[] | undefined
  memberEndpointsError: unknown
  ownerFilter: string | undefined
  toggleEndpoint: (endpoint: ConsoleMemberEndpoint) => Promise<void>
  webhookFilter: string | undefined
  confirmCancel: () => void
  deliveries: ConsoleWebhookDelivery[]
  deliveriesError: unknown
  error: unknown
  filter: string
  loading: boolean
  now: number
  opened: ConsoleWebhookDelivery | undefined
  openId: string | undefined
  pending: ConsoleWebhookDelivery[]
  pendingError: unknown
  redeliver: (entry: ConsoleWebhookDelivery) => Promise<void>
  sendNow: (entry: ConsoleWebhookDelivery) => Promise<void>
  sendTest: (webhook: ConsoleWebhook) => Promise<void>
  webhooks: ConsoleWebhook[]
}

const unmounts: Array<() => void> = []
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
  mocks.operation.mockReset()
  mocks.toast.mockReset()
  vi.useRealTimers()
})

const details = parseConsoleContributedSection(JSON.parse(JSON.stringify(describeViteHubConsoleSection(webhooksConsoleSection))))

async function mountWebhooks(path = "/webhooks") {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ component: {}, name: "vitehub-console-webhooks", path: "/webhooks" }] })
  await router.push(path)
  const app = renderer.createApp({ ...(Webhooks as Component), render: () => null }, { definitionsBase: "/definitions", details, sectionsBase: "/_vitehub/api/sections" })
  app.use(router)
  app.provide(ssrContextKey, {})
  const instance = app.mount({})
  unmounts.push(() => app.unmount())
  await nextTick()
  // SAFETY: tests read and write the setup state of the page they mount.
  return { router, state: (instance.$ as unknown as { setupState: WebhooksState }).setupState }
}

/** Answers each `webhooks.*` read from the lists, and records every call. Without `members`, member endpoints are off. */
function answer(lists: { deliveries?: ConsoleWebhookDelivery[], members?: ConsoleMemberEndpoint[], pending?: ConsoleWebhookDelivery[], webhooks?: ConsoleWebhook[] }, failures: Record<string, Error> = {}) {
  mocks.operation.mockImplementation(async (operation: string, input: Record<string, unknown>) => {
    if (failures[operation]) throw failures[operation]
    if (operation === "webhooks.endpoints") {
      if (lists.members) return lists.members
      throw new ConsoleRequestError(409, { code: "WEBHOOKS_ENDPOINTS_OFF", message: "Member endpoints are not on in this server." })
    }
    if (operation === "webhooks.list") return lists.webhooks ?? [t3]
    if (operation === "webhooks.pending") return lists.pending ?? []
    if (operation === "webhooks.deliveries") return (lists.deliveries ?? []).filter(entry => !input.state || entry.state === input.state)
    if (operation === "webhooks.get") return (lists.deliveries ?? []).find(entry => entry.id === input.id)
    return { id: "whd_new", status: "pending" }
  })
}

const calls = (operation: string) => mocks.operation.mock.calls.filter(([name]) => name === operation).map(([, input]) => input)

describe("Webhooks page", () => {
  const pendingT3 = delivery({ count: 4, dueAt: Date.now() + 21 * minute, id: "whd_pending", key: "page:/pricing", state: "pending" })
  const dead = delivery({ attempts: 4, id: "whd_dead", lastStatus: 502, state: "dead" })
  const sent = delivery({ attempts: 1, body: { thread: "thr_1" }, id: "whd_sent", lastStatus: 200, state: "sent" })

  it("loads the webhooks, the pending timers, and the log", async () => {
    answer({ deliveries: [dead, sent], pending: [pendingT3] })
    const { state } = await mountWebhooks()
    await vi.waitFor(() => expect(state.loading).toBe(false))
    expect(state.webhooks).toEqual([t3])
    expect(state.pending.map(entry => entry.id)).toEqual(["whd_pending"])
    expect(state.deliveries.map(entry => entry.id)).toEqual(["whd_dead", "whd_sent"])
    expect(calls("webhooks.deliveries")).toEqual([{}])
    expect(state.error).toBeUndefined()
  })

  it("reads the log filter from the URL and asks only for that state", async () => {
    answer({ deliveries: [dead, sent] })
    const { router, state } = await mountWebhooks("/webhooks?state=dead")
    await vi.waitFor(() => expect(state.deliveries.map(entry => entry.id)).toEqual(["whd_dead"]))
    expect(calls("webhooks.deliveries")).toEqual([{ state: "dead" }])
    state.filter = "sent"
    await vi.waitFor(() => expect(state.deliveries.map(entry => entry.id)).toEqual(["whd_sent"]))
    expect(router.currentRoute.value.query.state).toBe("sent")
  })

  it("shows a failed list in its place and keeps the others", async () => {
    answer({ deliveries: [sent] }, { "webhooks.pending": new Error("The Default Database is missing.") })
    const { state } = await mountWebhooks()
    await vi.waitFor(() => expect(state.loading).toBe(false))
    expect(state.error).toBeUndefined()
    expect(state.pendingError).toBeInstanceOf(Error)
    expect(state.deliveries.map(entry => entry.id)).toEqual(["whd_sent"])
  })

  it("shows a page error when the webhooks cannot be listed", async () => {
    answer({}, { "webhooks.list": new Error("Webhooks are not installed.") })
    const { state } = await mountWebhooks()
    await vi.waitFor(() => expect(state.error).toBeInstanceOf(Error))
  })

  it("runs Send test, Send now, Cancel, and Redeliver with the operations, then loads the lists again", async () => {
    answer({ deliveries: [dead, sent], pending: [pendingT3] })
    const { state } = await mountWebhooks()
    await vi.waitFor(() => expect(state.loading).toBe(false))
    const lists = () => calls("webhooks.list").length

    let before = lists()
    await state.sendTest(t3)
    expect(calls("webhooks.test")).toEqual([{ name: "t3" }])
    expect(lists()).toBe(before + 1)

    before = lists()
    await state.sendNow(pendingT3)
    expect(calls("webhooks.flush")).toEqual([{ id: "whd_pending" }])
    expect(lists()).toBe(before + 1)

    state.cancelling = pendingT3
    state.confirmCancel()
    await vi.waitFor(() => expect(calls("webhooks.cancel")).toEqual([{ id: "whd_pending" }]))
    expect(state.cancelling).toBeUndefined()

    await state.redeliver(dead)
    expect(calls("webhooks.redeliver")).toEqual([{ id: "whd_dead" }])
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it("shows the error of a failed action in a toast", async () => {
    answer({ deliveries: [sent] }, { "webhooks.test": new Error("T3_WEBHOOK_SECRET is not set.") })
    const { state } = await mountWebhooks()
    await vi.waitFor(() => expect(state.loading).toBe(false))
    await state.sendTest(t3)
    expect(mocks.toast).toHaveBeenCalledWith("T3_WEBHOOK_SECRET is not set.")
  })

  it("opens a delivery with its body through webhooks.get from the URL", async () => {
    answer({ deliveries: [sent] })
    const { state } = await mountWebhooks("/webhooks?delivery=whd_sent")
    await vi.waitFor(() => expect(state.opened?.body).toEqual({ thread: "thr_1" }))
    expect(calls("webhooks.get")).toEqual([{ id: "whd_sent" }])
    state.openId = undefined
    await vi.waitFor(() => expect(state.opened).toBeUndefined())
  })

  it("hides member endpoints while the app has them off", async () => {
    answer({ deliveries: [sent] })
    const { state } = await mountWebhooks()
    await vi.waitFor(() => expect(state.loading).toBe(false))
    expect(state.memberEndpoints).toBeUndefined()
    expect(state.memberEndpointsError).toBeUndefined()
    expect(state.error).toBeUndefined()
  })

  it("lists member endpoints read-only, disables one, and offers Redeliver and Send now only on the user's own", async () => {
    const toAna = delivery({ attempts: 1, id: "whd_ana", lastStatus: 202, state: "sent", webhook: "@whe_ana" })
    const toTom = delivery({ attempts: 1, id: "whd_tom", lastStatus: 401, state: "dead", webhook: "@whe_tom" })
    const retryAna = delivery({ id: "whd_retry", state: "pending", webhook: "@whe_ana" })
    answer({ deliveries: [toTom, toAna, sent], members: [ana, tom], pending: [retryAna], webhooks: [] })
    const { state } = await mountWebhooks()
    await vi.waitFor(() => expect(state.loading).toBe(false))
    expect(state.memberEndpoints).toEqual([ana, tom])
    expect(state.deliveryTarget(toTom)).toBe("Tom Becker · T3 Code")
    expect(state.deliveryTarget(delivery({ id: "whd_old", state: "sent", webhook: "@whe_gone" }))).toBe("A removed member endpoint")
    expect([toTom, toAna, sent].filter(entry => state.canRedeliver(entry)).map(entry => entry.id)).toEqual(["whd_tom", "whd_sent"])
    expect(state.canSendNow(retryAna)).toBe(false)

    await state.toggleEndpoint(ana)
    expect(calls("webhooks.disable-endpoint")).toEqual([{ id: "whe_ana" }])
    await state.toggleEndpoint({ ...tom, disabledAt: 1 })
    expect(calls("webhooks.enable-endpoint")).toEqual([{ id: "whe_tom" }])
    expect(mocks.toast).not.toHaveBeenCalled()
    // Admins never create or edit an endpoint.
    expect(mocks.operation.mock.calls.map(([name]) => name).filter(name => !["webhooks.list", "webhooks.pending", "webhooks.deliveries", "webhooks.endpoints", "webhooks.disable-endpoint", "webhooks.enable-endpoint"].includes(name))).toEqual([])
  })

  it("filters the log by owner and endpoint from the URL", async () => {
    answer({ deliveries: [], members: [ana, tom] })
    const { router, state } = await mountWebhooks("/webhooks?owner=user_tom&webhook=%40whe_tom")
    await vi.waitFor(() => expect(state.loading).toBe(false))
    expect(calls("webhooks.deliveries")).toEqual([{ owner: "user_tom", webhook: "@whe_tom" }])
    state.chooseOwner("all")
    await vi.waitFor(() => expect(calls("webhooks.deliveries").at(-1)).toEqual({ webhook: "@whe_tom" }))
    expect(router.currentRoute.value.query.owner).toBeUndefined()
  })

  it("loads the lists again until a sending delivery settles", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] })
    const sending = delivery({ attempts: 1, id: "whd_sending", state: "sending" })
    answer({ deliveries: [sending] })
    const { state } = await mountWebhooks()
    await vi.waitFor(() => expect(state.deliveries.map(entry => entry.state)).toEqual(["sending"]))
    answer({ deliveries: [{ ...sending, lastStatus: 200, state: "sent" }] })
    await vi.advanceTimersByTimeAsync(3_500)
    await vi.waitFor(() => expect(state.deliveries.map(entry => entry.state)).toEqual(["sent"]))
    const reads = calls("webhooks.deliveries").length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls("webhooks.deliveries")).toHaveLength(reads)
  })

  it("ticks the countdown each second while a timer waits", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] })
    answer({ pending: [{ ...pendingT3, dueAt: Date.now() + 21 * minute }] })
    const { state } = await mountWebhooks()
    await vi.waitFor(() => expect(state.pending).toHaveLength(1))
    const start = state.now
    await vi.advanceTimersByTimeAsync(3_000)
    expect(state.now - start).toBeGreaterThanOrEqual(3_000)
    expect(webhookCountdown(state.pending[0]!.dueAt, state.now)).toBe("fires in 21 min")
  })
})
