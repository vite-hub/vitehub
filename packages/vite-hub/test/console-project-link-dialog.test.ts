// @vitest-environment happy-dom
import { shallowMount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

import { startConsoleProjects } from "../src/console/runtime/client/project-session.ts"
import { memoryProjectStorage } from "../src/console/runtime/client/projects.ts"
import ConsoleProjectLink from "../src/console/runtime/components/console-project-link.vue"

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
    vi.stubGlobal("fetch", fetch)
    startConsoleProjects({ base: "", home: "/", mode, navigate: vi.fn(), pageOrigin: "https://console.example.com", storage: memoryProjectStorage() })
    const wrapper = shallowMount(ConsoleProjectLink, {
      props: { open: true },
      global: { stubs: { UModal, UButton, UFormField: { template: "<div><slot /></div>" }, UInput, UIcon: true } },
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
})
