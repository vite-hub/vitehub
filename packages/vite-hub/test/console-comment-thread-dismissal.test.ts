// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"
import { createMemoryHistory, createRouter, RouterView, useRoute } from "vue-router"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(),
  requestConsoleOperation: mocks.request,
}))
import Panel from "../src/console/runtime/components/console-comment-thread.vue"

const Slideover = defineComponent({
  props: { open: Boolean, content: Object },
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

const thread = (id: string) => ({
  id, n: 1, author: { id: "ana" }, subject: { id: "/pricing", kind: "page" }, anchor: { kind: "page" },
  messages: [], scope: "site", status: "open", createdAt: 1, updatedAt: 1,
})

async function panel(request?: typeof mocks.request) {
  mocks.request.mockImplementation(request ?? (async (_path, operation, input) => operation === "comments.get" ? {
    id: input.id, n: 1, author: { id: "ana" }, subject: { id: "/pricing", kind: "page" }, anchor: { kind: "page" },
    messages: [], scope: "site", status: "open", createdAt: 1, updatedAt: 1,
  } : operation === "comments.session" ? {
    canWrite: true, user: { id: "ana" }, capabilities: { reply: true, resolve: true, deleteThread: true, edit: [], delete: [] },
  } : []))
  const onClose = vi.fn()
  const Page = defineComponent({ setup() {
    const route = useRoute()
    return () => h(Panel, {
      id: typeof route.query.thread === "string" ? route.query.thread : undefined,
      definitionsBase: "/definitions", view: { kind: "operation-view", operation: "comments.list", columns: [], notice: "" }, onClose,
    })
  } })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/comments", component: Page }] })
  await router.push("/comments?thread=first")
  const wrapper = mount(defineComponent({ setup: () => () => h(RouterView) }), {
    attachTo: document.body,
    global: { plugins: [router], components: {
      USlideover: Slideover, UButton: Button,
      UIcon: defineComponent({ setup: () => () => h("span") }),
      UTooltip: defineComponent({ inheritAttrs: false, setup: (_props, { slots }) => () => slots.default?.() }),
    } },
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, onClose, router }
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

it("guards Back, Forward, and thread replacement while a reply is unsent", async () => {
  const { wrapper, onClose, router } = await panel()
  await router.push("/comments?thread=second")
  await flushPromises()
  await wrapper.get("textarea").setValue("Unsent reply")
  router.back()
  await flushPromises()
  expect(router.currentRoute.value.query.thread).toBe("second")
  expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("Unsent reply")
  expect(onClose).not.toHaveBeenCalled()
  await router.push("/comments?thread=third")
  expect(router.currentRoute.value.query.thread).toBe("second")
  await wrapper.get("textarea").setValue("")
  router.back()
  await flushPromises()
  expect(router.currentRoute.value.query.thread).toBe("first")
  await wrapper.get("textarea").setValue("Another draft")
  router.forward()
  await flushPromises()
  expect(router.currentRoute.value.query.thread).toBe("first")
  await router.push("/comments")
  expect(router.currentRoute.value.query.thread).toBe("first")
  await wrapper.get("textarea").setValue("")
  router.forward()
  await flushPromises()
  expect(router.currentRoute.value.query.thread).toBe("second")
})

it("focuses a deep-linked thread after its request completes", async () => {
  let finish!: (value: ReturnType<typeof thread>) => void
  const pending = new Promise<ReturnType<typeof thread>>(resolve => { finish = resolve })
  const { wrapper } = await panel(vi.fn(async (_path, operation) => operation === "comments.get" ? pending : {}))
  const event = new Event("openAutoFocus", { cancelable: true })
  wrapper.getComponent(Slideover).props("content")?.onOpenAutoFocus(event)
  await flushPromises()
  expect(event.defaultPrevented).toBe(true)
  finish(thread("first"))
  await flushPromises()
  expect(document.activeElement).toBe(wrapper.get("[data-slot='comment-thread']").element)
})

it("guards URL changes while editing a message", async () => {
  const { wrapper, router } = await panel(vi.fn(async (_path, operation, input) => operation === "comments.get" ? {
    ...thread(input.id), messages: [{
      id: "owned", threadId: input.id, author: { id: "ana" }, body: "Original", mentions: [], attachments: [], createdAt: 1,
    }],
  } : {
    user: { id: "ana" }, capabilities: { reply: false, resolve: false, deleteThread: false, edit: ["owned"], delete: [] },
  }))
  await wrapper.get("[aria-label='Edit']").trigger("click")
  await wrapper.get("textarea").setValue("Unsent edit")
  await router.push("/comments?thread=second")
  expect(router.currentRoute.value.query.thread).toBe("first")
  expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("Unsent edit")
})

it("keeps a successful reply visible when refreshing capabilities fails", async () => {
  const { wrapper } = await panel()
  mocks.request.mockImplementation(async (_path, operation) => {
    if (operation === "comments.session") throw new Error("Session unavailable")
    return { ...thread("first"), messages: [{
      id: "saved", threadId: "first", author: { id: "ana" }, body: "Saved reply", mentions: [], attachments: [], createdAt: 2,
    }] }
  })
  await wrapper.get("textarea").setValue("Saved reply")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(wrapper.find("[data-slot='comment-thread']").exists()).toBe(true)
  expect(wrapper.text()).toContain("Saved reply")
  expect(wrapper.text()).not.toContain("Couldn't load the thread")
  expect(wrapper.get("[role='alert']").text()).toContain("permissions")
})
