// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils"
import type { DefineComponent } from "vue"
import { describe, expect, it, vi } from "vitest"

import type { ConsoleAccountProject } from "../src/console/runtime/client/account"

const mocks = vi.hoisted(() => ({ register: vi.fn(), show: vi.fn(), slot: { template: "<div><slot /></div>" }, toast: vi.fn() }))
vi.mock("@vite-hub/ui", () => ({
  CodeBlock: mocks.slot,
  CodeBlockActions: mocks.slot,
  CodeBlockContent: { template: "<pre data-code><slot /></pre>" },
  CodeBlockCopyButton: { props: ["value"], template: "<button data-copy-code :data-value='value' />" },
  CodeBlockHeader: mocks.slot,
  CodeBlockTitle: mocks.slot,
  CopyButton: { props: ["value", "label"], template: "<button data-copy-prompt :data-value='value'>{{ label }}</button>" },
}))
vi.mock("../src/console/runtime/client/project-session", () => ({
  registerAccountProject: mocks.register,
  showLinkedAccountProject: mocks.show,
  useConsoleProjects: () => ({ pageOrigin: "https://console.example.com" }),
}))
vi.mock("../src/console/runtime/client/toast", () => ({ useConsoleToast: () => ({ show: mocks.toast }) }))
vi.mock("../src/console/runtime/components/console-account-snippet.vue", () => ({ default: { template: "<p>snippet</p>" } }))

import Link from "../src/console/runtime/components/console-account-link.vue"
import { hostedCommentsScript } from "../src/console/runtime/client/link-prompts"

const site: ConsoleAccountProject = { id: "proj_site", url: "https://docs.example.com", label: null, publicKey: null, keyVariable: null }
const app: ConsoleAccountProject = { id: "proj_app", url: "https://app.example.com", label: null, publicKey: "pk_123", keyVariable: "VITEHUB_CONSOLE_KEY_ABC" }

type LinkComponent = DefineComponent<{ "open": boolean, "url"?: string, "onUpdate:open"?: (open: boolean) => void }>

function mountLink() {
  const wrapper = mount<typeof Link, LinkComponent>(Link, {
    props: { "open": true, "onUpdate:open": (open: boolean) => wrapper.setProps({ open }) },
    global: { components: {
      UModal: { props: ["title", "description"], template: "<section><h2>{{ title }}</h2><p data-description>{{ description }}</p><slot name='body' /><slot name='footer' /></section>" },
      UCheckbox: { props: ["modelValue", "label"], emits: ["update:modelValue"], template: "<input type='checkbox' :checked='modelValue' @change='$emit(\"update:modelValue\", $event.target.checked)' />" },
      UFormField: { props: ["label", "error"], template: "<div><slot /><span v-if='error' role='alert'>{{ error }}</span></div>" },
      UInput: { props: ["modelValue"], emits: ["update:modelValue"], template: "<input :value='modelValue' @input='$emit(\"update:modelValue\", $event.target.value)' />" },
      UButton: { props: ["label"], template: "<button type='button'>{{ label }}</button>" },
    } },
  })
  return wrapper
}

describe("Link dialog of the account Console", () => {
  it("shows the site script with its repository and a prompt that adds it to the HTML head", async () => {
    mocks.register.mockResolvedValueOnce(site)
    mocks.show.mockClear()
    const wrapper = mountLink()
    await wrapper.get("input[type=checkbox]").setValue(true)
    await wrapper.get("input[placeholder='https://app.example.com']").setValue("https://docs.example.com")
    await wrapper.get("input[placeholder='owner/name']").setValue("acme/docs")
    expect(wrapper.text()).toContain("Register site")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(mocks.register).toHaveBeenCalledWith("https://docs.example.com", "", "site")
    const script = "<script type=\"module\" src=\"https://console.example.com/hosted-comments.js\" data-vitehub-comments=\"proj_site\" data-vitehub-repo=\"acme/docs\"></script>"
    expect(wrapper.get("h2").text()).toBe("Site registered")
    expect(wrapper.get("[data-code]").text()).toBe(script)
    expect(wrapper.get("[data-copy-code]").attributes("data-value")).toBe(script)
    const prompt = wrapper.get("[data-copy-prompt]")
    expect(prompt.text()).toBe("Copy prompt")
    expect(prompt.attributes("data-value")).toContain("in the <head> of every page")
    expect(prompt.attributes("data-value")).toContain(script)
    expect(wrapper.find("form").exists()).toBe(false)
    expect(mocks.show).not.toHaveBeenCalled()

    await wrapper.findAll("button").find(button => button.text() === "Open site")!.trigger("click")
    expect(mocks.show).toHaveBeenCalledWith("proj_site")
    expect(wrapper.find("form").exists()).toBe(true)
  })

  it("shows the variable line of an app and a prompt that sets it", async () => {
    mocks.register.mockResolvedValueOnce(app)
    mocks.show.mockClear()
    const wrapper = mountLink()
    expect(wrapper.find("input[placeholder='owner/name']").exists()).toBe(false)
    await wrapper.get("input[placeholder='https://app.example.com']").setValue("https://app.example.com")
    expect(wrapper.text()).toContain("Link app")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(mocks.register).toHaveBeenCalledWith("https://app.example.com", "", undefined)
    expect(wrapper.get("h2").text()).toBe("App linked")
    expect(wrapper.get("[data-code]").text()).toBe("VITEHUB_CONSOLE_KEY_ABC=pk_123")
    const prompt = wrapper.get("[data-copy-prompt]").attributes("data-value")
    expect(prompt).toContain("https://app.example.com")
    expect(prompt).toContain("`console: true`")
    expect(prompt).toContain("VITEHUB_CONSOLE_KEY_ABC=pk_123")

    await wrapper.setProps({ open: false })
    expect(mocks.show).toHaveBeenCalledWith("proj_app")
  })

  it("keeps the form and shows the problem when the link fails", async () => {
    mocks.register.mockRejectedValueOnce(new Error("The URL is already linked."))
    mocks.show.mockClear()
    const wrapper = mountLink()
    await wrapper.get("input[placeholder='https://app.example.com']").setValue("https://app.example.com")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(wrapper.get("[role=alert]").text()).toBe("The URL is already linked.")
    expect(wrapper.find("[data-copy-prompt]").exists()).toBe(false)
    await wrapper.setProps({ open: false })
    expect(mocks.show).not.toHaveBeenCalled()
  })

  it("adds the repository attribute only for an owner/name value", () => {
    expect(hostedCommentsScript("https://c.example", "p", " acme/docs ")).toContain(" data-vitehub-repo=\"acme/docs\"")
    for (const repo of [undefined, "", "acme", "acme/docs\" onload=\"x", "https://github.com/acme/docs"]) {
      expect(hostedCommentsScript("https://c.example", "p", repo)).not.toContain("data-vitehub-repo")
    }
  })
})
