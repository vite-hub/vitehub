// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils"
import { defineComponent, h } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createConsoleDocumentsClient } from "../src/console/runtime/client/documents"
import { consoleTabSession } from "../src/console/runtime/client/presence"
import { readConsoleLocalDraft } from "../src/console/runtime/client/preview"
import { ConsoleRequestError } from "../src/console/runtime/client/request"
import { useConsoleToast } from "../src/console/runtime/client/toast"
import ConsoleDocumentEditor from "../src/console/runtime/components/console-document-editor.vue"

import type { ConsoleDocument, ConsoleDocumentCollection, ConsoleDocumentPresence, ConsoleDocumentSession } from "../src/console/runtime/client/documents"

vi.mock("vue-router", () => ({
  onBeforeRouteLeave: vi.fn(),
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
/** How often the body editor mounted. A remount drops keystrokes that it has not written to the model yet. */
const editorMounts = vi.hoisted(() => ({ count: 0 }))
vi.mock("../src/console/runtime/components/console-markdown-editor.vue", () => ({
  default: { name: "ConsoleMarkdownEditor", props: ["modelValue"], emits: ["update:modelValue"], setup: (_props: unknown, { expose }: { expose: (exposed: object) => void }) => {
    editorMounts.count++
    expose({ commit: async () => undefined })
    return () => null
  } },
}))

// A Markdown collection without a live room: one editor at a time holds the lease.
const collection: ConsoleDocumentCollection = {
  access: { read: true, write: true, publish: true },
  format: "markdown",
  label: "Posts",
  name: "posts",
  path: "posts/*.md",
  schema: { type: "object", properties: { title: { type: "string" } } },
  titleField: "title",
}

const UButton = defineComponent({
  props: { label: String, disabled: Boolean, loading: Boolean },
  setup: props => () => h("button", { "data-label": props.label, disabled: props.disabled || props.loading }, props.label),
})
const UModal = defineComponent({
  props: { open: Boolean },
  setup: (props, { slots }) => () => props.open ? h("section", [slots.body?.(), slots.footer?.()]) : null,
})
interface MenuItem { label: string, onUpdateChecked?: () => void }
const UDropdownMenu = defineComponent({
  name: "UDropdownMenu",
  props: { items: { type: Array, default: () => [] } },
  setup: (_props, { slots }) => () => h("div", slots.default?.()),
})
const stubs = {
  ConsolePageHeader: { template: "<header><slot name='right' /></header>" },
  ConsoleStatus: { props: ["label"], template: "<span>{{ label }}</span>" },
  UButton,
  UModal,
  UDropdownMenu,
  UTooltip: { template: "<slot />" },
  UFieldGroup: { template: "<slot />" },
  UEmpty: true, UFormField: true, UInputDate: true, UInputTime: true,
}

const wrappers: Array<{ unmount(): void }> = []
const toasts = useConsoleToast()
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  sessionStorage.clear()
  for (const toast of toasts.toasts.value) toasts.remove(toast.id)
})

const other: ConsoleDocumentSession = { collection: "posts", id: "hello", kind: "edit", self: false, since: "2026-10-29T10:00:00.000Z", user: { id: "ben", name: "Ben" } }
const leaseHolder = () => new ConsoleRequestError(409, "Conflict", { code: "CONTENT_LEASE_HELD", details: { holder: other } })

/**
 * The Content store and its edit lease. Tab B holds the lease until `leave()`. A save checks the shared draft digest
 * and refuses a tab without the lease, as the server does.
 */
function server() {
  let version = 1
  const state = {
    holder: "tab-b" as string | null,
    kinds: [] as Array<string | undefined>,
    shared: { body: "Shared body", collection: "posts", data: { title: "Shared" }, digest: "shared-1", id: "hello", path: "posts/hello.md", revision: "r1", state: "changed", updatedAt: null } as ConsoleDocument,
    leave() {
      state.holder = null
    },
    move(title: string) {
      state.shared = { ...state.shared, data: { title }, digest: `shared-${++version}` }
    },
  }
  const presence = (): ConsoleDocumentPresence => ({
    available: true,
    digest: state.shared.digest,
    editing: state.holder === consoleTabSession,
    holder: state.holder === "tab-b" ? other : state.holder ? { ...other, self: true, user: { id: "ana", name: "Ana" } } : null,
    lease: true,
    now: "2026-10-29T10:05:00.000Z",
    sessions: [],
    user: { id: "ana", name: "Ana" },
  })
  const client = {
    ...createConsoleDocumentsClient("", "content"),
    get: vi.fn(async () => structuredClone(state.shared)),
    session: vi.fn(async (_collection: string, _id: string, input: { action: string, kind?: "edit" | "view", session: string }) => {
      if (input.action === "acquire" && state.holder === null) state.holder = input.session
      if (input.action === "release" && state.holder === input.session) state.holder = null
      if (input.action === "report") {
        state.kinds.push(input.kind)
        if (input.kind === "view" && state.holder === input.session) state.holder = null
      }
      return presence()
    }),
    save: vi.fn(async (_collection: string, _id: string, input: { body?: string, data?: Record<string, unknown>, ifDigest?: string | null, session?: string }) => {
      if (state.holder !== input.session) throw leaseHolder()
      if (input.ifDigest !== state.shared.digest) throw new ConsoleRequestError(409, "Conflict", { code: "WORKSPACE_CONFLICT", details: {} })
      state.shared = { ...state.shared, body: input.body ?? "", data: input.data ?? {}, digest: `shared-${++version}` }
      return structuredClone(state.shared)
    }),
  }
  return { state, client }
}

const privateEdit = { title: "PRIVATE local title" }

function mount(client: ReturnType<typeof server>["client"]) {
  const wrapper = shallowMount(ConsoleDocumentEditor, { props: { changes: 0, client, collection, documentId: "hello" }, global: { stubs: { ...stubs, ConsoleMarkdownEditor: false } } })
  wrappers.push(wrapper)
  return wrapper
}

/** The tab reports again, as on its 15 second loop. */
async function report(): Promise<void> {
  // The happy-dom environment provides the document. Browser types stay out of this test program.
  const page: { dispatchEvent(event: Event): boolean } = Reflect.get(globalThis, "document")
  page.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()
}

/**
 * Opens the document while tab B holds the lease, chooses Open read-only, switches to Local only, and types a private
 * title and body.
 */
async function readOnlyThenLocal() {
  const { state, client } = server()
  const wrapper = mount(client)
  await flushPromises()
  await wrapper.get('section [data-label="Open read-only"]').trigger("click")
  await flushPromises()
  const menu = wrapper.findAllComponents(UDropdownMenu).find(item => JSON.stringify(item.props("items")).includes("Local only"))!
  const items = (menu.props("items") as MenuItem[][]).flat()
  items.find(item => item.label === "Local only")!.onUpdateChecked!()
  await flushPromises()
  await wrapper.get("textarea").setValue(privateEdit.title)
  wrapper.getComponent({ name: "ConsoleMarkdownEditor" }).vm.$emit("update:modelValue", "PRIVATE body")
  await flushPromises()
  expect(wrapper.text()).toContain("Local edits · not saved")
  return { state, client, wrapper }
}

const apply = async (wrapper: ReturnType<typeof mount>) => {
  await wrapper.get('article [data-label="Apply to shared draft"]').trigger("click")
  await flushPromises()
}
const stored = () => readConsoleLocalDraft(sessionStorage, "posts", "hello")?.version

describe("Apply from Local only after the lease holder leaves", () => {
  it("takes the free lease and saves the private edits over the shared draft they started from", async () => {
    const { state, client, wrapper } = await readOnlyThenLocal()
    state.leave()
    await report()
    await apply(wrapper)
    expect(client.save).toHaveBeenCalledOnce()
    expect(client.save).toHaveBeenLastCalledWith("posts", "hello", expect.objectContaining({ body: "PRIVATE body", data: privateEdit, ifDigest: "shared-1" }))
    expect(state.shared.data).toEqual(privateEdit)
    expect(stored()).toBeUndefined()
    expect(wrapper.text()).not.toContain("Local edits · not saved")
  })

  it("says who holds the lease, saves nothing, and keeps the edits while another tab still edits", async () => {
    const { state, client, wrapper } = await readOnlyThenLocal()
    expect(wrapper.text()).toContain("Ben is editing the shared draft. Apply when they stop.")
    await apply(wrapper)
    expect(client.save).not.toHaveBeenCalled()
    expect(client.session).toHaveBeenCalledWith("posts", "hello", expect.objectContaining({ action: "acquire" }))
    expect(toasts.toasts.value.at(-1)).toMatchObject({ error: true, title: expect.stringContaining("Ben is editing the shared draft"), action: { label: "Retry" } })
    expect(stored()).toEqual({ body: "PRIVATE body", data: privateEdit })
    // Apply never takes the lease from its holder.
    expect(state.holder).toBe("tab-b")
    expect(client.session).not.toHaveBeenCalledWith("posts", "hello", expect.objectContaining({ action: "takeover" }))

    // The holder leaves; Retry from the toast now saves.
    state.leave()
    await report()
    expect(wrapper.text()).not.toContain("is editing the shared draft")
    await toasts.toasts.value.at(-1)!.action!.onClick()
    await flushPromises()
    expect(client.save).toHaveBeenLastCalledWith("posts", "hello", expect.objectContaining({ data: privateEdit, ifDigest: "shared-1" }))
  })

  it("compares first when the shared draft moved, then gives the lease back and keeps the edits local", async () => {
    const { state, client, wrapper } = await readOnlyThenLocal()
    state.leave()
    state.move("Ben saved before leaving")
    await report()
    await apply(wrapper)
    expect(client.save.mock.settledResults.at(-1)?.type).toBe("rejected")
    expect(state.shared.data).toEqual({ title: "Ben saved before leaving" })
    expect(wrapper.text()).toContain("Overwrite with mine")
    expect(stored()).toEqual({ body: "PRIVATE body", data: privateEdit })
    // Local only reports as a viewer again, so the lease is free for others.
    expect(state.kinds.at(-1)).toBe("view")
    expect(state.holder).toBeNull()
  })

  it("reads a moved shared draft without mounting the body editor again", async () => {
    const { state, client, wrapper } = await readOnlyThenLocal()
    const mounts = editorMounts.count
    const reads = client.get.mock.calls.length
    state.move("Saved by Ben")
    // A presence answer names the new shared digest. SAFETY: happy-dom provides `document`; this tsconfig has no DOM library.
    ;(globalThis as unknown as { document: EventTarget }).document.dispatchEvent(new Event("visibilitychange"))
    await flushPromises()
    expect(client.get.mock.calls.length).toBeGreaterThan(reads)
    expect(wrapper.text()).toContain("Someone saved the shared draft after your local edits started")
    expect(editorMounts.count).toBe(mounts)
    expect(stored()).toEqual({ body: "PRIVATE body", data: privateEdit })
  })

  it("keeps the private edits through a reload, then applies them", async () => {
    const { state, client, wrapper } = await readOnlyThenLocal()
    await apply(wrapper)
    expect(client.save).not.toHaveBeenCalled()
    wrapper.unmount()
    state.leave()
    const reloaded = mount(client)
    await flushPromises()
    expect(reloaded.text()).toContain("Local edits · not saved")
    expect(stored()).toEqual({ body: "PRIVATE body", data: privateEdit })
    await apply(reloaded)
    expect(client.save).toHaveBeenLastCalledWith("posts", "hello", expect.objectContaining({ body: "PRIVATE body", data: privateEdit, ifDigest: "shared-1" }))
  })
})
