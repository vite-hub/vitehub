// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent, h, ref, type Component } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { expect, it, vi } from "vitest"
import { queryChoice, querySelection, useConsoleQuery } from "../src/console/runtime/client/route-query"

vi.mock("../src/console/runtime/components/console-session-inspector.vue", () => ({ default: { render: () => null } }))
vi.mock("../src/console/runtime/components/console-session-copy-link.vue", () => ({ default: { render: () => null } }))
vi.mock("../src/console/runtime/components/console-session-loading.vue", () => ({ default: { render: () => null } }))

import Session from "../src/console/runtime/components/console-agent-session.vue"
import type { AgentInvocationView } from "../src/console/runtime/components/invocation/types"

it.each([false, true])("counts deleted files alongside other changes (mixed: %s)", async (mixed) => {
  localStorage.clear()
  const timestamp = "2026-11-07T10:00:00.000Z"
  const deleted = "diff --git a/deleted.ts b/deleted.ts\n--- a/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n"
  const modified = "diff --git a/edited.ts b/edited.ts\n--- a/edited.ts\n+++ b/edited.ts\n@@ -1 +1 @@\n-old\n+new\n"
  const invocation = {
    id: "run", createdAt: timestamp, updatedAt: timestamp, traceId: "trace", status: "completed",
    observations: [{
      name: "agent.turn.diff.updated", sequence: 1, timestamp, type: "run",
      attributes: { "vitehub.activity.kind": "change", "vitehub.activity.body": deleted + (mixed ? modified + modified : "") },
    }],
  } satisfies AgentInvocationView
  const wrapper = mount(Session, {
    props: { loading: false, title: "Session", invocation },
    global: { stubs: { AgentInvocation: true, UIcon: true } },
  })
  try {
    await wrapper.get('[data-slot="agent-session-details-toggle"]').trigger("click")
    const row = wrapper.findAll('[data-slot="agent-session-details-row"]').find(row => row.text().includes("Changed files"))
    expect(row?.find(".vh-agent-session__row-value").text()).toBe(mixed ? "2" : "1")
  }
  finally { wrapper.unmount() }
})

it("opens the desktop launcher from Open a surface while the lone tab stays open", async () => {
  localStorage.clear()
  const host = defineComponent({
    setup() {
      const tab = ref("details")
      return () => h(Session as Component, {
        loading: false, title: "Session", details: "open", tab: tab.value,
        "onUpdate:tab": (value: string) => { tab.value = value },
      })
    },
  })
  const wrapper = mount(host, { global: { components: { UIcon: { render: () => null } } } })
  try {
    expect(wrapper.find('button[aria-label="Close Details"]').exists()).toBe(false)
    await wrapper.get('button[aria-label="Open a surface"]').trigger("click")
    expect(wrapper.find('[data-slot="agent-session-launcher"]').exists()).toBe(true)
    expect(wrapper.find('[role="tab"][aria-selected="true"]').exists()).toBe(false)
    await wrapper.get('[data-slot="agent-session-launcher"] button').trigger("click")
    expect(wrapper.find('[data-slot="agent-session-launcher"]').exists()).toBe(false)
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toContain("Trace")
  }
  finally { wrapper.unmount() }
})

it("restores desktop surfaces, visibility, and maximization through the URL and Back/Forward", async () => {
  localStorage.clear()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/session", component: {} }] })
  await router.push("/session?tab=workspace&file=README.md")
  const host = defineComponent({
    setup() {
      const state = useConsoleQuery({
        details: queryChoice(["closed", "open", "max"], "closed", { history: "push" }),
        tab: queryChoice(["details", "trace", "workspace", "diff", "capabilities"], "details", { history: "push" }),
        file: querySelection(),
      })
      return () => h(Session as Component, {
        loading: false, title: "Session", workspaceBase: "/api",
        details: state.details.value, tab: state.tab.value, selectedPath: state.file.value,
        "onUpdate:details": (value: typeof state.details.value) => { state.details.value = value },
        "onUpdate:tab": (value: typeof state.tab.value) => { state.tab.value = value },
      })
    },
  })
  const wrapper = mount(host, { global: { plugins: [router], components: { UIcon: { render: () => null } } } })
  try {
    await flushPromises()
    const panel = () => wrapper.get(".vh-agent-session")
    const selected = () => wrapper.get('[role="tab"][aria-selected="true"]').text()
    expect(panel().attributes()).not.toHaveProperty("data-panel-open")
    await router.push("/session?details=open&tab=trace&file=README.md")
    await flushPromises()
    expect(panel().attributes()).toHaveProperty("data-panel-open")
    expect(selected()).toContain("Trace")
    await wrapper.get('[aria-label="Maximize panel"]').trigger("click")
    await flushPromises()
    expect(router.currentRoute.value.query.details).toBe("max")
    expect(panel().attributes()).toHaveProperty("data-maximized")
    await router.push("/session?details=open&tab=workspace")
    await flushPromises()
    expect(selected()).toContain("Workspace")
    await wrapper.findAll('[role="tab"]').find(tab => tab.text().includes("Trace"))!.trigger("mousedown", { button: 0 })
    await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe("trace")
    router.back()
    await flushPromises()
    expect(selected()).toContain("Workspace")
    await wrapper.get('[aria-label="Close the right panel"]').trigger("click")
    await flushPromises()
    expect(router.currentRoute.value.query.details).toBeUndefined()
    expect(panel().attributes()).not.toHaveProperty("data-panel-open")
    router.back()
    await flushPromises()
    expect(panel().attributes()).toHaveProperty("data-panel-open")
    expect(selected()).toContain("Workspace")
    router.back()
    await flushPromises()
    expect(selected()).toContain("Trace")
    expect(panel().attributes()).toHaveProperty("data-maximized")
    router.forward()
    await flushPromises()
    expect(selected()).toContain("Workspace")
    await router.push("/session?details=max&tab=trace")
    await flushPromises()
    await wrapper.get('[aria-label="Close the right panel"]').trigger("click")
    await flushPromises()
    expect(router.currentRoute.value.query.details).toBeUndefined()
    expect(panel().attributes()).not.toHaveProperty("data-panel-open")
    router.back()
    await flushPromises()
    expect(panel().attributes()).toHaveProperty("data-maximized")
  }
  finally { wrapper.unmount() }
})
