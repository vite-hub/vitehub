import { createRenderer, nextTick, ssrContextKey } from "vue"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: mocks.request }))
vi.mock("@vite-hub/ui", () => ({ AgentCapabilityInspector: {}, AgentFileTree: {}, AgentInvocationInspector: {} }))
vi.mock("../src/console/runtime/components/console-session-code-preview.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-session-trace.vue", () => ({ default: {} }))

import Inspector from "../src/console/runtime/components/console-session-inspector.vue"

// Run the real component setup and watchers without the presentation components.
const renderer = createRenderer({
  createComment: () => ({}),
  createElement: () => ({}),
  createText: () => ({}),
  insert() {},
  nextSibling: () => null,
  parentNode: () => null,
  patchProp() {},
  remove() {},
  setElementText() {},
  setText() {},
})

describe("Console inspector initialization", () => {
  it("requests a preselected file without waiting for a Workspace scan", async () => {
    const path = ".agents/skills/runs/SKILL.md"
    let resolveResponse: (value: unknown) => void = () => {}
    const response = new Promise<unknown>(resolve => { resolveResponse = resolve })
    mocks.request.mockReturnValue(response)
    const app = renderer.createApp({ ...Inspector, render: () => null }, {
      invocation: { id: "run" },
      workspaceBase: "/api/invocations",
      tab: "workspace",
      activeSurface: `file:${path}`,
      selectedPath: path,
      openPaths: [path],
    })
    app.provide(ssrContextKey, {})
    try {
      app.mount({})
      expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
        `/api/invocations/run/workspace?path=${encodeURIComponent(path)}`,
        { signal: expect.any(AbortSignal) },
      )
      resolveResponse({ path, content: "Skill instructions", revision: "current", size: 18 })
      await response
      await nextTick()
      expect(mocks.request).toHaveBeenCalledTimes(1)
    } finally {
      app.unmount()
    }
  })
})
