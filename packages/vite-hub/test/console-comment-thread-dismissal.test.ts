// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(),
  requestConsoleOperation: mocks.request,
}))
import Panel from "../src/console/runtime/components/console-comment-thread.vue"

const Slideover = defineComponent({
  props: { open: Boolean },
  emits: ["update:open"],
  setup: (props, { slots }) => () => props.open ? h("div", slots.content?.()) : null,
})
const Button = defineComponent({
  setup: (_props, { attrs, slots }) => () => h("button", attrs, slots.default?.() ?? String(attrs.label ?? "")),
})
const mounted: VueWrapper[] = []
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  mocks.request.mockReset()
  document.body.innerHTML = ""
})

async function panel() {
  mocks.request.mockImplementation(async (_path, operation, input) => operation === "comments.get" ? {
    id: input.id, n: 1, author: { id: "ana" }, subject: { id: "/pricing", kind: "page" }, anchor: { kind: "page" },
    messages: [], scope: "site", status: "open", createdAt: 1, updatedAt: 1,
  } : operation === "comments.session" ? {
    canWrite: true, user: { id: "ana" }, capabilities: { reply: true, resolve: true, deleteThread: true, edit: [], delete: [] },
  } : [])
  const onClose = vi.fn()
  const wrapper = mount(defineComponent({ setup: () => () => h(Panel, {
    id: "first", definitionsBase: "/definitions", view: { kind: "operation-view", operation: "comments.list", columns: [], notice: "" }, onClose,
  }) }), {
    attachTo: document.body,
    global: { components: {
      USlideover: Slideover, UButton: Button,
      UIcon: defineComponent({ setup: () => () => h("span") }),
      UTooltip: defineComponent({ inheritAttrs: false, setup: (_props, { slots }) => () => slots.default?.() }),
    } },
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, onClose }
}

it("guards slideover dismissal with unsent text and still closes an empty composer", async () => {
  const { wrapper, onClose } = await panel()
  await wrapper.get("textarea").setValue("Unsent reply")
  // Escape and outside interaction both request this open-state update from Nuxt UI.
  wrapper.getComponent(Slideover).vm.$emit("update:open", false)
  await flushPromises()
  expect(onClose).not.toHaveBeenCalled()
  expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("Unsent reply")
  await wrapper.get("textarea").setValue("")
  wrapper.getComponent(Slideover).vm.$emit("update:open", false)
  expect(onClose).toHaveBeenCalledOnce()
})
