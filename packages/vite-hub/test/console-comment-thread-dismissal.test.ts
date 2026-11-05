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
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: defineComponent({ setup: (_props, { slots }) => () => slots.default?.() }) }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))
import OperationView from "../src/console/runtime/components/console-operation-view.vue"
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

async function panel(request?: typeof mocks.request, operationView = false) {
  mocks.request.mockImplementation(request ?? (async (_path, operation, input) => operation === "comments.get" ? {
    id: input.id, n: 1, author: { id: "ana" }, subject: { id: "/pricing", kind: "page" }, anchor: { kind: "page" },
    messages: [], scope: "site", status: "open", createdAt: 1, updatedAt: 1,
  } : operation === "comments.session" ? {
    canWrite: true, user: { id: "ana" }, capabilities: { reply: true, resolve: true, deleteThread: true, edit: [], delete: [] },
  } : []))
  const onClose = vi.fn()
  const Page = defineComponent({ setup() {
    const route = useRoute()
    return () => operationView ? h(OperationView, {
      definitionsBase: "/definitions", sectionsBase: "/sections",
      details: { id: "comments", label: "Comments", view: {
        kind: "operation-view", operation: "comments.list", notice: "", columns: [{ key: "id", label: "ID" }],
        detail: { kind: "comment-thread" },
      } },
    }) : h(Panel, {
      id: typeof route.query.thread === "string" ? route.query.thread : undefined,
      definitionsBase: "/definitions", view: { kind: "operation-view", operation: "comments.list", columns: [], notice: "" }, onClose,
    })
  } })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/comments", component: Page }, { path: "/other", component: { render: () => h("p", "Other section") } }] })
  await router.push("/comments?thread=first")
  const wrapper = mount(defineComponent({ setup: () => () => h(RouterView) }), {
    attachTo: document.body,
    global: { plugins: [router], components: {
      USlideover: Slideover, UButton: Button,
      UDashboardPanel: defineComponent({ setup: (_props, { slots }) => () => [slots.header?.(), slots.body?.()] }),
      UInput: defineComponent({ render: () => null }),
      UModal: defineComponent({ setup: (_props, { slots }) => () => slots.default?.() }),
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

const ownedThread = (id: string) => ({ ...thread(id), messages: [{
  id: `${id}-owned`, threadId: id, author: { id: "ana" }, body: "Original", mentions: [], attachments: [], createdAt: 1,
}] })
const session = { user: { id: "ana" }, capabilities: { reply: true, resolve: true, deleteThread: false, edit: ["first-owned", "second-owned"], delete: [] } }

it.each(["reply", "edit"])("guards leaving the Comments section with an unsent %s", async (kind) => {
  const { wrapper, router, onClose } = await panel(vi.fn(async (_path, operation, input) => operation === "comments.get" ? ownedThread(input.id) : session))
  if (kind === "edit") await wrapper.get("[aria-label='Edit']").trigger("click")
  const field = kind === "edit" ? wrapper.get("[data-slot='comment-reply'] textarea") : wrapper.get("[data-slot='comment-thread'] > [data-slot='comment-composer'] textarea")
  await field.setValue("Unsent draft")
  await router.push("/other")
  await flushPromises()
  expect(router.currentRoute.value.path).toBe("/comments")
  expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("Unsent draft")
  expect(onClose).not.toHaveBeenCalled()
  await wrapper.get("textarea").setValue("")
  await router.push("/other")
  expect(router.currentRoute.value.path).toBe("/other")
})

it.each(["reply", "edit"])("guards selecting another row with an unsent %s", async (kind) => {
  const { wrapper, router } = await panel(vi.fn(async (_path, operation, input) => operation === "comments.list" ? [ownedThread("first"), ownedThread("second")] : operation === "comments.get" ? ownedThread(input.id) : session), true)
  await vi.waitFor(() => expect(wrapper.find("textarea").exists()).toBe(true))
  if (kind === "edit") await wrapper.get("[aria-label='Edit']").trigger("click")
  const field = wrapper.get("textarea")
  await field.setValue("Unsent draft")
  const row = wrapper.findAll("tbody button").find(button => button.text() === "second")!
  await row.trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.query.thread).toBe("first")
  expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("Unsent draft")
  await wrapper.get("textarea").setValue("")
  await row.trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.query.thread).toBe("second")
})

it("authorizes mention searches in the open thread, including after switching threads", async () => {
  const request = vi.fn(async (_path, operation, input) => {
    if (operation === "comments.get") return thread(input.id)
    if (operation === "comments.users") {
      if (!input.threadId) throw new Error("Thread-scoped authorization denied")
      return [{ id: "ben", name: "Ben" }]
    }
    return session
  })
  const { wrapper, router } = await panel(request)
  for (const id of ["first", "second"]) {
    await router.push(`/comments?thread=${id}`)
    await flushPromises()
    await wrapper.get("textarea").setValue("@be")
    await vi.waitFor(() => expect(wrapper.findAll("[data-slot=comment-composer-mention-name]").map(item => item.text())).toEqual(["Ben"]))
    expect(request).toHaveBeenCalledWith("/definitions", "comments.users", { query: "be", threadId: id })
    await wrapper.get("textarea").setValue("")
  }
})

it("loads existing attachments through the authorized operation and releases their URLs", async () => {
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:attachment")
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  try {
    const { wrapper, router } = await panel(vi.fn(async (_path, operation, input) => operation === "comments.get" ? {
      ...ownedThread(input.id), messages: ownedThread(input.id).messages.map(message => ({ ...message, attachments: ["files/notes"] })),
    } : operation === "comments.attachment" ? { data: btoa("File contents"), name: "notes.txt", type: "text/plain", inline: false } : session))
    await vi.waitFor(() => expect(wrapper.find("[data-slot=comment-reply-attachments] a").exists()).toBe(true))
    expect(wrapper.get("[data-slot=comment-reply-attachments] a").attributes("href")).toBe("blob:attachment")
    expect(wrapper.get("[data-slot=comment-reply-attachments] a").text()).toBe("notes.txt")
    expect(mocks.request).toHaveBeenCalledWith("/definitions", "comments.attachment", { key: "files/notes" }, expect.anything())
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: "application/octet-stream", size: 13 }))
    await router.push("/other")
    await flushPromises()
    expect(revoke).toHaveBeenCalledWith("blob:attachment")
  } finally {
    create.mockRestore()
    revoke.mockRestore()
  }
})

it("keeps the thread visible when an attachment is denied and retries the authorized read", async () => {
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image")
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  let denied = true
  try {
    const { wrapper, router } = await panel(vi.fn(async (_path, operation) => {
      if (operation === "comments.get") return { ...ownedThread("first"), messages: ownedThread("first").messages.map(message => ({ ...message, attachments: ["image"] })) }
      if (operation === "comments.attachment") {
        if (denied) throw new Error("Forbidden")
        return { data: btoa("PNG"), name: "shot.png", type: "image/png", inline: true }
      }
      return session
    }))
    expect(wrapper.find("[data-slot=comment-thread]").exists()).toBe(true)
    expect(wrapper.get("[role=alert]").text()).toContain("attachments")
    expect(create).not.toHaveBeenCalled()
    denied = false
    await wrapper.get("button[label=Retry]").trigger("click")
    await flushPromises()
    expect(wrapper.find("[role=alert]").exists()).toBe(false)
    expect(wrapper.get("img[alt='shot.png']").attributes("src")).toBe("blob:image")
    await router.push("/other")
    await flushPromises()
    expect(revoke).toHaveBeenCalledWith("blob:image")
  } finally {
    create.mockRestore()
    revoke.mockRestore()
  }
})

it("aborts attachment reads when switching threads and ignores their late results", async () => {
  let finish!: (file: { data: string, inline: boolean, name: string, type: string }) => void
  const pending = new Promise(resolve => { finish = resolve })
  const create = vi.spyOn(URL, "createObjectURL")
  try {
    const { router, wrapper } = await panel(vi.fn(async (_path, operation, input) => {
      if (operation === "comments.get") return input.id === "first" ? {
        ...ownedThread("first"), messages: ownedThread("first").messages.map(message => ({ ...message, attachments: ["file"] })),
      } : thread(input.id)
      if (operation === "comments.attachment") return pending
      return session
    }))
    const call = mocks.request.mock.calls.find(([, operation]) => operation === "comments.attachment")!
    await router.push("/comments?thread=second")
    await flushPromises()
    expect(call[3].signal.aborted).toBe(true)
    finish({ data: btoa("Late"), inline: false, name: "late.txt", type: "text/plain" })
    await flushPromises()
    expect(create).not.toHaveBeenCalled()
    expect(wrapper.find("[data-slot=comment-reply-attachments]").exists()).toBe(false)
  } finally {
    create.mockRestore()
  }
})
