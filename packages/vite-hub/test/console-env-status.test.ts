import { createRenderer, nextTick, ssrContextKey } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import { envPushCommand, envStatusFix } from "../src/console/runtime/client/env-status.ts"
import type { ConsoleEnvInspect } from "../src/console/runtime/client/env-status.ts"

const mocks = vi.hoisted(() => ({ operation: vi.fn(), request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", async (original) => ({
  ...await original<typeof import("../src/console/runtime/client/request.ts")>(),
  requestConsole: mocks.request,
  requestConsoleOperation: mocks.operation,
}))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))

const { ConsoleNetworkError, ConsoleRequestError } = await import("../src/console/runtime/client/request.ts")
const { default: Env } = await import("../src/console/runtime/components/console-env.vue")

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

const declarations = [
  { path: "env.server.stripeKey", names: ["VITEHUB_STRIPE_KEY", "STRIPE_KEY"], source: "env", secret: true, required: true, hasDefault: false },
  { path: "env.server.region", names: ["VITEHUB_REGION", "REGION"], source: "env", secret: false, required: true, hasDefault: true },
  { path: "env.server.token", source: "provider", provider: "vault", secret: true, required: true, hasDefault: false },
]

const available = { entries: [
  { blocking: false, name: "STRIPE_KEY", names: ["VITEHUB_STRIPE_KEY", "STRIPE_KEY"], path: "env.server.stripeKey", required: true, secret: true, source: "env", status: "available" },
  { blocking: false, names: ["VITEHUB_REGION", "REGION"], path: "env.server.region", required: true, secret: false, source: "env", status: "defaulted" },
  { blocking: false, path: "env.server.token", provider: "vault", required: true, secret: true, source: "provider", status: "available" },
], host: "cloudflare", ok: true } satisfies ConsoleEnvInspect

const missing = { ...available, ok: false, entries: [{ ...available.entries[0], blocking: true, name: undefined, status: "missing" }, ...available.entries.slice(1)] } satisfies ConsoleEnvInspect
const providerError = { ...available, ok: false, entries: [...available.entries.slice(0, 2), { ...available.entries[2], blocking: true, status: "error" }] } satisfies ConsoleEnvInspect

interface EnvState {
  attentionOnly: boolean
  failed: unknown
  fix: { title: string, description: string } | undefined
  refresh: () => Promise<void>
  rows: typeof declarations
  statuses: ReadonlyMap<unknown, { name?: string, status: string }> | undefined
  statusFailed: boolean
  statusUnavailable: boolean
}

async function mountEnv(): Promise<{ state: EnvState, unmount: () => void }> {
  const app = renderer.createApp({ ...Env, render: () => null }, {
    agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", envBase: "/env", searchBase: "/search", sectionsBase: "/sections",
  })
  app.provide(ssrContextKey, {})
  const instance = app.mount({})
  const state = (instance.$ as unknown as { setupState: EnvState }).setupState
  await vi.waitFor(() => expect(mocks.operation).toHaveBeenCalled())
  await nextTick()
  await new Promise(resolve => setTimeout(resolve))
  return { state, unmount: () => app.unmount() }
}

afterEach(() => {
  mocks.request.mockReset()
  mocks.operation.mockReset()
})

describe("Env status view", () => {
  it("shows every value as resolved and names the host variable that supplied it", async () => {
    mocks.request.mockResolvedValue({ entries: declarations })
    mocks.operation.mockResolvedValue(available)
    const { state, unmount } = await mountEnv()
    try {
      expect(mocks.operation).toHaveBeenCalledWith("env.inspect", {}, expect.anything())
      expect(state.fix).toBeUndefined()
      expect([...state.statuses!.values()].map(entry => [entry.status, entry.name])).toEqual([["available", "STRIPE_KEY"], ["defaulted", undefined], ["available", undefined]])
    }
    finally {
      unmount()
    }
  })

  it("shows a missing required value with the push command for the app's host", async () => {
    mocks.request.mockResolvedValue({ entries: declarations })
    mocks.operation.mockResolvedValue(missing)
    const { state, unmount } = await mountEnv()
    try {
      expect(state.fix).toEqual({
        title: "1 value blocks the app",
        description: "`VITEHUB_STRIPE_KEY` is not set on the host. Run `vitehub env push --host cloudflare` to set it from `.env.<stage>`, then deploy again.",
      })
      state.attentionOnly = true
      expect(state.rows).toEqual([declarations[0]])
    }
    finally {
      unmount()
    }
  })

  it("shows a provider error as blocking with a provider hint", async () => {
    mocks.request.mockResolvedValue({ entries: declarations })
    mocks.operation.mockResolvedValue(providerError)
    const { state, unmount } = await mountEnv()
    try {
      expect(state.fix?.description).toBe("`vault` did not answer. Check the provider and its credentials.")
      expect([...state.statuses!.values()][2]?.status).toBe("error")
    }
    finally {
      unmount()
    }
  })

  it("shows an error state when the app is unreachable", async () => {
    mocks.request.mockRejectedValue(new ConsoleNetworkError(new TypeError("fetch failed")))
    mocks.operation.mockRejectedValue(new ConsoleNetworkError(new TypeError("fetch failed")))
    const { state, unmount } = await mountEnv()
    try {
      expect(state.failed).toBeInstanceOf(ConsoleNetworkError)
      expect(state.statuses).toBeUndefined()
    }
    finally {
      unmount()
    }
  })

  it("keeps the declarations when the app has no env.inspect or the check fails", async () => {
    mocks.request.mockResolvedValue({ entries: declarations })
    mocks.operation.mockRejectedValueOnce(new ConsoleRequestError(404, "Console operation not found.")).mockResolvedValueOnce(missing).mockRejectedValueOnce(new ConsoleRequestError(503, "Unavailable."))
    const { state, unmount } = await mountEnv()
    try {
      expect(state.statusUnavailable).toBe(true)
      expect(state.rows).toEqual(declarations)
      await state.refresh()
      state.attentionOnly = true
      expect(state.rows).toEqual([declarations[0]])
      await state.refresh()
      expect(state.statusFailed).toBe(true)
      expect(state.statuses).toBeUndefined()
      expect(state.rows).toEqual(declarations)
      expect(state.attentionOnly).toBe(false)
    }
    finally {
      unmount()
    }
  })
})

describe("envStatusFix", () => {
  it("leaves out --host for an app whose host is not known", () => {
    expect(envPushCommand(undefined)).toBe("vitehub env push")
    expect(envStatusFix({ ...missing, host: undefined })?.description).toContain("Run `vitehub env push` to set it")
  })

  it("tells a Node server to set the value in its environment", () => {
    expect(envStatusFix({ ...missing, host: "node" })?.description).toBe("`VITEHUB_STRIPE_KEY` is not set. Set it in the server environment, then restart the app.")
  })
})
