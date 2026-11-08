// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent, h, type Component } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { expect, it, vi } from "vitest"
import { queryChoice, querySelection, useConsoleQuery } from "../src/console/runtime/client/route-query"

vi.mock("../src/console/runtime/components/console-session-inspector.vue", () => ({ default: { render: () => null } }))
vi.mock("../src/console/runtime/components/console-session-copy-link.vue", () => ({ default: { render: () => null } }))
vi.mock("../src/console/runtime/components/console-session-loading.vue", () => ({ default: { render: () => null } }))

import Session from "../src/console/runtime/components/console-agent-session.vue"

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
    await wrapper.findAll('[role="tab"]').find(tab => tab.text().includes("Trace"))!.trigger("click")
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
