// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"

import { continueConsoleOpen, startConsoleOpen } from "../src/console/runtime/client/open-link.ts"
import { consoleProjectReady, startConsoleProjects } from "../src/console/runtime/client/project-session.ts"
import { memoryProjectStorage } from "../src/console/runtime/client/projects.ts"
import ConsoleProjectLink from "../src/console/runtime/components/console-project-link.vue"
import { operationRpcFetch } from "../../internal/test-utils/operation-rpc.ts"

const UButton = defineComponent({
  props: { label: String, disabled: Boolean, loading: Boolean },
  setup: props => () => h("button", { disabled: props.disabled || props.loading }, props.label),
})
const UModal = defineComponent({
  props: { open: Boolean },
  setup: (props, { slots }) => () => props.open ? h("section", slots.body?.()) : null,
})
const UInput = defineComponent({
  props: { type: String },
  setup: props => () => h("input", { type: props.type }),
})

afterEach(() => vi.unstubAllGlobals())

describe("Link project dialog", () => {
  it.each(["hosted", "embedded"] as const)("keeps linking by URL available in %s mode without offering the unsupported init command", (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", operationRpcFetch(fetch))
    startConsoleProjects({ base: "", home: "/", mode, navigate: vi.fn(), pageOrigin: "https://console.example.com", storage: memoryProjectStorage() })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: {} }] })
    const wrapper = shallowMount(ConsoleProjectLink, {
      props: { open: true },
      global: { plugins: [router], stubs: { UModal, UButton, UFormField: { template: "<div><slot /></div>" }, UInput, UIcon: true } },
    })
    try {
      expect(wrapper.find("code").exists()).toBe(false)
      expect(wrapper.findAll("button").map(button => button.text())).toEqual(["Continue"])
      expect(wrapper.get("form input").attributes("type")).toBe("url")
      expect(wrapper.text()).not.toContain("vite-hub init")
      expect(fetch).not.toHaveBeenCalled()
    }
    finally {
      wrapper.unmount()
    }
  })

  it("submits the prefilled first project and opens its page without reloading", async () => {
    vi.stubGlobal("fetch", operationRpcFetch(vi.fn(async () => Response.json({ ok: true, value: { protocol: 1, name: "Shop", vitehub: "0.1.0", sections: ["kv"], operations: ["kv.list"] } }))))
    const storage = memoryProjectStorage()
    const request = startConsoleOpen({ location: { pathname: "/open", search: "?project=https://shop.example.com&path=/kv" }, history: { state: null, replaceState: vi.fn() } }, "/", storage)
    const navigate = vi.fn()
    const state = startConsoleProjects({ base: "", home: "/", mode: "hosted", navigate, pageOrigin: "https://console.example.com", storage })
    if (!request) throw new Error("Expected an open request")
    continueConsoleOpen(request)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: {} }, { path: "/kv", component: {} }] })
    router.beforeEach(() => consoleProjectReady())
    const wrapper = shallowMount(ConsoleProjectLink, {
      props: { open: true },
      global: { plugins: [router], stubs: { UModal, UButton, UFormField: { template: "<div><slot /></div>" }, UInput, UIcon: true } },
    })
    try {
      await wrapper.get("form").trigger("submit")
      await flushPromises()
      expect(navigate).not.toHaveBeenCalled()
      await router.isReady()
      expect(router.currentRoute.value.path).toBe("/kv")
      expect(state.current.value?.url).toBe("https://shop.example.com")
      expect(wrapper.emitted("update:open")).toEqual([[false]])
    }
    finally {
      wrapper.unmount()
    }
  })
})
