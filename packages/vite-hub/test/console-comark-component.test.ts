// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"

import ConsoleComarkComponent from "../src/console/runtime/components/console-comark-component.vue"

import type { ConsoleMediaPicker } from "../src/console/runtime/client/media"
import type { ConsoleDocumentComponent } from "../src/console/runtime/definitions"

const picker = vi.hoisted(() => ({ current: undefined as ConsoleMediaPicker | undefined }))
vi.mock("../src/console/runtime/client/media", () => ({ useConsoleMediaPicker: () => picker.current }))

vi.mock("@tiptap/vue-3", async () => {
  const { defineComponent, h } = await import("vue")
  const wrapper = defineComponent({ props: { as: String }, setup: (props, { slots }) => () => h(props.as ?? "div", slots.default?.()) })
  return { NodeViewContent: wrapper, NodeViewWrapper: wrapper }
})

const fieldNote: ConsoleDocumentComponent = {
  kind: "block",
  label: "Field note",
  name: "field-note",
  props: { icon: { store: "media", type: "image" }, title: { type: "string" } },
}

function mountNote(attrs: Record<string, unknown>) {
  const updateAttributes = vi.fn()
  const wrapper = mount(ConsoleComarkComponent, {
    // The node view gets more Tiptap props than the component reads.
    props: { definition: fieldNote, editor: { isEditable: true }, node: { attrs: { name: "field-note", props: attrs } }, updateAttributes } as never,
    global: {
      stubs: {
        UButton: { inheritAttrs: false, props: ["icon"], template: "<button type=\"button\" :aria-label=\"$attrs['aria-label']\" @click=\"$attrs.onClick\" />" },
        UIcon: true,
        UInput: { props: ["modelValue"], template: "<input :value=\"modelValue\">" },
        UPopover: { template: "<div><slot /><slot name=\"content\" /></div>" },
        USwitch: true,
      },
    },
  })
  return { updateAttributes, wrapper }
}

describe("Comark component image props", () => {
  it("picks from the Media picker of the field's store and stores the served URL", async () => {
    const pick = vi.fn<ConsoleMediaPicker["pick"]>(async () => [{ reference: { contentType: "image/webp", pathname: "icons/train.webp" }, src: "icons/train.webp" }])
    picker.current = { pick, resolveSrc: src => `/media/${src}` }
    const { updateAttributes, wrapper } = mountNote({ title: "Book early" })
    await wrapper.get("[aria-label='Choose an image for icon']").trigger("click")
    await flushPromises()
    expect(pick).toHaveBeenCalledWith({ accept: ["image/*"], files: [], kind: "image", multiple: false, store: "media" })
    expect(updateAttributes).toHaveBeenCalledWith({ props: { icon: "/media/icons/train.webp", title: "Book early" } })
  })

  it("stores the pathname when the store is not served, and keeps the value when the person cancels", async () => {
    const pick = vi.fn<ConsoleMediaPicker["pick"]>(async () => [{ src: "icons/plane.webp" }])
    picker.current = { pick, resolveSrc: () => undefined }
    const { updateAttributes, wrapper } = mountNote({ icon: "icons/train.webp" })
    expect(wrapper.text()).toContain("icon=icons/train.webp")
    await wrapper.get("[aria-label='Choose an image for icon']").trigger("click")
    await flushPromises()
    expect(updateAttributes).toHaveBeenLastCalledWith({ props: { icon: "icons/plane.webp" } })
    pick.mockResolvedValueOnce([])
    await wrapper.get("[aria-label='Choose an image for icon']").trigger("click")
    await flushPromises()
    expect(updateAttributes).toHaveBeenCalledTimes(1)
  })

  it("shows the prop as text without a picker", () => {
    picker.current = undefined
    const { wrapper } = mountNote({ icon: "/media/icons/train.webp" })
    expect(wrapper.find("[aria-label='Choose an image for icon']").exists()).toBe(false)
    expect(wrapper.findAll("input").map(input => input.element.value)).toContain("/media/icons/train.webp")
  })
})
