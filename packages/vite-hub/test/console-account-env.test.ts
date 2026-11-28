import { createRenderer, ssrContextKey } from "vue"
import { describe, expect, it, vi } from "vitest"

const opened = vi.hoisted(() => ({ id: "" }))
vi.mock("../src/console/runtime/client/account", () => ({
  deleteConsoleEnvValue: vi.fn(),
  loadConsoleEnvStage: vi.fn(() => new Promise(() => {})),
  revealConsoleEnvValue: vi.fn(),
  setConsoleEnvValue: vi.fn(),
}))
vi.mock("../src/console/runtime/client/toast", () => ({ useConsoleToast: () => ({ show: vi.fn() }) }))
vi.mock("../src/console/runtime/client/project-session", async () => {
  const { shallowRef } = await import("vue")
  const projects = [{ id: "first", url: "https://first.example.com" }, { id: "second", url: "https://second.example.com" }]
  return {
    consoleProjectDisplayName: (project: { url: string }) => new URL(project.url).host,
    useConsoleProjects: () => ({
      account: shallowRef({ projects }),
      current: shallowRef(projects.find(project => project.id === opened.id)),
    }),
  }
})
import AccountEnv from "../src/console/runtime/components/console-account-env.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

function selectedApp(): string | undefined {
  const app = renderer.createApp({ ...AccountEnv, render: () => null })
  app.provide(ssrContextKey, {})
  const instance = app.mount({})
  try {
    return (instance.$ as unknown as { setupState: { appId: string | undefined } }).setupState.appId
  } finally { app.unmount() }
}

describe("Env values page", () => {
  it("selects the app that is open, not the first app of the team", () => {
    opened.id = "second"
    expect(selectedApp()).toBe("second")
  })

  it("selects the first app when no app is open", () => {
    opened.id = ""
    expect(selectedApp()).toBe("first")
  })
})
