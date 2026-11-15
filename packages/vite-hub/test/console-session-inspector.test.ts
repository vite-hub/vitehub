import { createRenderer, createSSRApp, defineComponent, h, nextTick, ref, ssrContextKey, type Component, type PropType } from "vue"
import { renderToString } from "vue/server-renderer"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: mocks.request }))
vi.mock("@vite-hub/ui", () => ({
  FileTree: {},
  PatchDiff: {},
}))
vi.mock("../src/console/runtime/components/invocation", () => ({
  AgentCapabilityInspector: {},
  AgentInvocationInspector: {
    props: ["showSources"],
    setup: (props: { showSources: boolean }) => () => props.showSources ? h("div", "Recorded Sources") : null,
  },
  invocationActivities: () => [],
}))
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
  it("keeps recorded sources in Details before a Workspace descriptor is available", async () => {
    const app = createSSRApp(Inspector, {
      invocation: { id: "run" },
      workspaceBase: "/api/invocations",
      tab: "details",
      activeSurface: "view:details",
      openViews: ["details"],
    })
    for (const name of ["UIcon", "UDropdownMenu", "UButton", "UTooltip", "UKbd", "UEmpty"]) {
      app.component(name, { render: () => null })
    }
    expect(await renderToString(app)).toContain("Recorded Sources")
  })

  it("shows no key hints on tab launchers, because no key opens a tab", async () => {
    const menuItems: Record<string, unknown>[] = []
    const app = createSSRApp(Inspector, {
      invocation: { id: "run" },
      tab: "details",
      activeSurface: "",
      openViews: [],
    })
    app.component("UDropdownMenu", defineComponent({
      props: { items: { type: Array as PropType<Record<string, unknown>[]>, required: true } },
      setup(props, { slots }) {
        menuItems.push(...props.items)
        return () => slots.default?.()
      },
    }))
    app.component("UTooltip", defineComponent({ setup: (_props, { slots }) => () => slots.default?.() }))
    app.component("UKbd", defineComponent({ setup: (_props, { slots }) => () => h("kbd", slots.default?.()) }))
    app.component("UEmpty", defineComponent({ props: { title: String }, setup: (props, { slots }) => () => h("div", [props.title, slots.body?.()]) }))
    for (const name of ["UIcon", "UButton"]) {
      app.component(name, { render: () => null })
    }
    const html = await renderToString(app)
    expect(html).not.toContain("<kbd")
    // A session without recorded capabilities has no Capabilities tab to offer.
    expect(menuItems.map(item => item.label)).toEqual(["Details", "Trace"])
    expect(menuItems.filter(item => "kbds" in item)).toEqual([])
  })

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

  it("keeps the restored view active when the retained file changes", async () => {
    mocks.request.mockReturnValue(new Promise(() => {}))
    const tab = ref("workspace")
    const selectedPath = ref("first.md")
    const activeSurface = ref("file:first.md")
    const HeadlessInspector: Component = { ...Inspector, render: () => null }
    const app = renderer.createApp({
      setup: () => () => h(HeadlessInspector, {
        invocation: { id: "run" },
        workspaceBase: "/api/invocations",
        tab: tab.value,
        "onUpdate:tab": (value: string) => { tab.value = value },
        selectedPath: selectedPath.value,
        "onUpdate:selectedPath": (value: string) => { selectedPath.value = value },
        activeSurface: activeSurface.value,
        "onUpdate:activeSurface": (value: string) => { activeSurface.value = value },
        openViews: ["workspace", "trace", "details"],
        openPaths: ["first.md", "second.md"],
      }),
    })
    app.provide(ssrContextKey, {})
    try {
      app.mount({})
      tab.value = "trace"
      selectedPath.value = "second.md"
      activeSurface.value = "view:trace"
      await nextTick()
      expect(tab.value).toBe("trace")
      expect(activeSurface.value).toBe("view:trace")
      tab.value = "details"
      selectedPath.value = "first.md"
      activeSurface.value = "view:details"
      await nextTick()
      expect(tab.value).toBe("details")
      expect(activeSurface.value).toBe("view:details")
    } finally {
      app.unmount()
    }
  })
})
