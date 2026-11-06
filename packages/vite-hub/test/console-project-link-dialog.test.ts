// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

import { consoleLinkVerifier } from "../src/console/runtime/client/pending-links.ts"
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

afterEach(() => vi.unstubAllGlobals())

describe("new project command in the Link project dialog", () => {
  it("creates a browser-local ticket on click and displays only its id and verifier in the init command", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const state = startConsoleProjects({ base: "", home: "/", mode: "hosted", navigate: vi.fn(), pageOrigin: "https://console.example.com", storage: memoryProjectStorage() })
    const wrapper = shallowMount(ConsoleProjectLink, {
      props: { open: true },
      global: { stubs: { UModal, UButton, UFormField: { template: "<div><slot /></div>" }, UInput: true, UIcon: true } },
    })
    try {
      expect(wrapper.find("code").exists()).toBe(false)
      const create = wrapper.findAll("button").find(button => button.text() === "Link a new project")
      expect(create, "A person can start the flow without seeding storage").toBeDefined()
      await create!.trigger("click")
      await vi.waitFor(() => expect(wrapper.find("code").exists()).toBe(true))
      await flushPromises()

      const command = wrapper.get("code").text()
      const match = /^vite-hub init --console ([\w-]{16}):sha256:([\da-f]{64})$/.exec(command)
      expect(match).not.toBeNull()
      const pending = state.pendingLinks.lookup(match![1]!)
      if (pending.kind !== "pending") throw new Error("Expected a stored pending link")
      expect(await consoleLinkVerifier(pending.link.secret)).toBe(match![2])
      expect(wrapper.text()).not.toContain(pending.link.secret)
      expect(fetch).not.toHaveBeenCalled()
    }
    finally {
      wrapper.unmount()
    }
  })

  it("does not offer one-time link creation in the embedded Console", () => {
    startConsoleProjects({ base: "", home: "/_vitehub/", mode: "embedded", navigate: vi.fn(), pageOrigin: "http://localhost", storage: memoryProjectStorage() })
    const wrapper = shallowMount(ConsoleProjectLink, {
      props: { open: true },
      global: { stubs: { UModal, UButton, UFormField: { template: "<div><slot /></div>" }, UInput: true, UIcon: true } },
    })
    expect(wrapper.text()).not.toContain("Link a new project")
    wrapper.unmount()
  })
})
