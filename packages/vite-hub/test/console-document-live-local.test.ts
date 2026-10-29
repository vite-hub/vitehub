// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils"
import { defineComponent, h, ref, shallowRef } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createConsoleDocumentsClient } from "../src/console/runtime/client/documents"
import { readConsoleLocalDraft } from "../src/console/runtime/client/preview"
import { ConsoleRequestError } from "../src/console/runtime/client/request"
import ConsoleDocumentEditor from "../src/console/runtime/components/console-document-editor.vue"

import type { ConsoleDocument, ConsoleDocumentCollection } from "../src/console/runtime/client/documents"

/** The body the live room editor holds now: the person keeps typing after the room took its save. */
const roomBody = vi.hoisted(() => ({ value: "" }))
const roomSave = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "room-1"))
/** The room fields, which another person or this tab can change while a room save is pending. */
const room = vi.hoisted(() => ({ fields: undefined as { value: Record<string, unknown> | undefined } | undefined }))

/** The route query, which opens and closes the side browser with `?preview`. */
const route = vi.hoisted(() => ({ current: { query: {} as Record<string, string | null> } }))
vi.mock("vue-router", async () => {
  const { reactive } = await import("vue")
  const current = (route.current = reactive({ query: {} }))
  return {
    onBeforeRouteLeave: vi.fn(),
    useRoute: () => current,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(({ query }: { query: Record<string, string | null> }) => (current.query = query)) }),
  }
})
vi.mock("../src/console/runtime/components/console-markdown-editor.vue", () => ({
  default: { name: "ConsoleMarkdownEditor", props: ["modelValue", "live"], emits: ["update:modelValue", "change"], setup: (_props: unknown, { expose }: { expose: (exposed: object) => void }) => {
    expose({ commit: async () => undefined, markdown: async () => roomBody.value })
    return () => null
  } },
}))
vi.mock("../src/console/runtime/client/live", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/live")>(),
  useConsoleLiveDocument: () => ({
    document: shallowRef({}),
    fields: (room.fields = shallowRef<Record<string, unknown> | undefined>()),
    focus: () => undefined,
    issues: ref([]),
    readOnlyReason: ref(null),
    saveStatus: ref({ savedAt: null }),
    writeFields: () => undefined,
    identity: shallowRef({ name: "Ana", color: "#000" }),
    others: ref([]),
    provider: shallowRef({}),
    ready: ref(true),
    save: roomSave,
    status: ref("connected"),
  }),
}))
vi.mock("../src/console/runtime/client/presence", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/presence")>(),
  useConsoleDocumentPresence: () => ({
    acquire: async () => true,
    claim: async () => true,
    holder: ref(null),
    mayWrite: ref(true),
    mode: ref("free"),
    others: ref([]),
    ownOtherTab: ref(false),
    presence: ref(null),
    resume: () => undefined,
    refresh: async () => undefined,
    unreachable: ref(false),
  }),
}))

const collection: ConsoleDocumentCollection = {
  access: { read: true, write: true, publish: true },
  format: "markdown",
  label: "Posts",
  name: "posts",
  path: "posts/*.md",
  schema: { type: "object", properties: { title: { type: "string" } } },
  titleField: "title",
}
const shared: ConsoleDocument = { body: "Saved by the room", collection: "posts", data: { title: "Shared" }, digest: "room-1", id: "hello", path: "posts/hello.md", revision: "r1", state: "changed", updatedAt: null }

const UButton = defineComponent({
  props: { label: String, disabled: Boolean, loading: Boolean },
  setup: props => () => h("button", { "data-label": props.label, disabled: props.disabled || props.loading }, props.label),
})
const UDropdownMenu = defineComponent({
  name: "UDropdownMenu",
  props: { items: { type: Array, default: () => [] } },
  setup: (_props, { slots }) => () => h("div", slots.default?.()),
})
const stubs = {
  ConsolePageHeader: { template: "<header><slot name='right' /></header>" },
  ConsoleStatus: { props: ["label"], template: "<span>{{ label }}</span>" },
  UButton,
  UDropdownMenu,
  UModal: true,
  UTooltip: { template: "<slot />" },
  UFieldGroup: { template: "<slot />" },
  UEmpty: true, UFormField: true, UInputDate: true, UInputTime: true,
}

const wrappers: Array<{ unmount(): void }> = []
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  sessionStorage.clear()
  roomSave.mockClear()
  route.current.query = {}
})

function chooseLocal(wrapper: ReturnType<typeof shallowMount>): void {
  const menu = wrapper.findAllComponents(UDropdownMenu).find(item => JSON.stringify(item.props("items")).includes("Local only"))!
  const items = (menu.props("items") as Array<Array<{ label: string, onUpdateChecked?: () => void }>>).flat()
  items.find(item => item.label === "Local only")!.onUpdateChecked!()
}

describe("Local only from a live room", () => {
  it("keeps the body typed after the room took its save", async () => {
    const client = { ...createConsoleDocumentsClient("", "content"), get: vi.fn(async () => structuredClone(shared)) }
    const wrapper = shallowMount(ConsoleDocumentEditor, {
      props: { changes: 0, client, collection, documentId: "hello", setup: { live: { definition: "content" } } },
      global: { stubs: { ...stubs, ConsoleMarkdownEditor: false } },
    })
    wrappers.push(wrapper)
    await flushPromises()
    // The room syncs its fields after it joins.
    room.fields!.value = { title: "Shared" }
    await flushPromises()
    roomBody.value = "Saved by the room, and typed after the save"
    chooseLocal(wrapper)
    await flushPromises()

    expect(roomSave).toHaveBeenCalledOnce()
    expect(wrapper.getComponent({ name: "ConsoleMarkdownEditor" }).props("modelValue")).toBe(roomBody.value)
    // The local edits start from the body the room saved, so Apply compares against that version.
    const stored = readConsoleLocalDraft(sessionStorage, "posts", "hello")
    expect(stored?.base).toBe("room-1")
    expect(stored?.start.body).toBe(shared.body)
    expect(stored?.version.body).toBe(roomBody.value)
    expect(wrapper.text()).toContain("Local edits · not saved")
  })

  it("keeps fields and body typed while the room save is pending as local edits", async () => {
    // The server accepted the version the room saved: title Shared and the saved body.
    const client = { ...createConsoleDocumentsClient("", "content"), get: vi.fn(async () => structuredClone(shared)), save: vi.fn() }
    const wrapper = shallowMount(ConsoleDocumentEditor, {
      props: { changes: 0, client, collection, documentId: "hello", setup: { live: { definition: "content" } } },
      global: { stubs: { ...stubs, ConsoleMarkdownEditor: false } },
    })
    wrappers.push(wrapper)
    await flushPromises()
    // The room syncs its fields after it joins.
    room.fields!.value = { title: "Shared" }
    await flushPromises()
    let finishSave!: (digest: string) => void
    roomSave.mockImplementationOnce(() => new Promise(resolve => (finishSave = resolve)))
    roomBody.value = shared.body
    chooseLocal(wrapper)
    await flushPromises()
    // The room save is pending. The title changes in the room, and the body changes in the editor.
    room.fields!.value = { title: "Typed during the save" }
    roomBody.value = "Saved by the room, then typed during the save"
    await flushPromises()
    finishSave("room-1")
    await flushPromises()

    const stored = readConsoleLocalDraft(sessionStorage, "posts", "hello")
    expect(stored?.base).toBe("room-1")
    expect(stored?.start).toEqual({ body: shared.body, data: shared.data })
    expect(stored?.version).toEqual({ body: roomBody.value, data: { title: "Typed during the save" } })
    expect(wrapper.text()).toContain("Local edits · not saved")
    const apply = wrapper.findAll("button").find(button => button.attributes("data-label") === "Apply to shared draft")!
    expect(apply.attributes("disabled")).toBeUndefined()
    // Nothing was published or saved from this tab.
    expect(client.save).not.toHaveBeenCalled()
  })

  it("names the digest the room save stored, so a draft saved after it makes Apply compare", async () => {
    const moved: ConsoleDocument = { ...shared, body: "Saved by Ben after the room", digest: "ben-2" }
    const client = {
      ...createConsoleDocumentsClient("", "content"),
      get: vi.fn(async () => structuredClone(shared)),
      save: vi.fn(async () => {
        throw new ConsoleRequestError(409, "Conflict", { code: "WORKSPACE_CONFLICT", details: {} })
      }),
    }
    const wrapper = shallowMount(ConsoleDocumentEditor, {
      props: { changes: 0, client, collection, documentId: "hello", setup: { live: { definition: "content" } } },
      global: { stubs: { ...stubs, ConsoleMarkdownEditor: false } },
    })
    wrappers.push(wrapper)
    await flushPromises()
    // The room save stores room-1. Ben saves before this tab reads the draft again.
    client.get.mockImplementation(async () => structuredClone(moved))
    roomBody.value = "Typed in the room"
    chooseLocal(wrapper)
    await flushPromises()

    expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")?.base).toBe("room-1")
    expect(wrapper.text()).toContain("Someone saved the shared draft after your local edits started")
    await wrapper.findAll("button").find(button => button.attributes("data-label") === "Apply to shared draft")!.trigger("click")
    await flushPromises()
    expect(client.save).toHaveBeenCalledOnce()
    expect(client.save.mock.calls[0]![2]).toMatchObject({ ifDigest: "room-1" })
    // Nothing overwrote Ben's draft: the store refused the old digest, and the edits stay local.
    expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")?.version.body).toBe("Typed in the room")
  })

  it("starts unchanged when nothing was typed during the room save", async () => {
    const client = { ...createConsoleDocumentsClient("", "content"), get: vi.fn(async () => structuredClone(shared)) }
    const wrapper = shallowMount(ConsoleDocumentEditor, {
      props: { changes: 0, client, collection, documentId: "hello", setup: { live: { definition: "content" } } },
      global: { stubs: { ...stubs, ConsoleMarkdownEditor: false } },
    })
    wrappers.push(wrapper)
    await flushPromises()
    // The room syncs its fields after it joins.
    room.fields!.value = { title: "Shared" }
    await flushPromises()
    // The room editor writes the body without the trailing newline of the stored file.
    roomBody.value = shared.body
    chooseLocal(wrapper)
    await flushPromises()
    expect(wrapper.text()).toContain("Local only")
    expect(wrapper.text()).not.toContain("Local edits · not saved")
  })

  it("shows the room body on screen when the preview opens again, after typing while it was closed", async () => {
    const client = { ...createConsoleDocumentsClient("", "content"), get: vi.fn(async () => ({ ...structuredClone(shared), url: "/blog/hello" })) }
    const wrapper = shallowMount(ConsoleDocumentEditor, {
      props: { changes: 0, client, collection, documentId: "hello", setup: { live: { definition: "content" } } },
      global: { stubs: { ...stubs, ConsoleMarkdownEditor: false } },
    })
    wrappers.push(wrapper)
    await flushPromises()
    // The room syncs its fields after it joins.
    room.fields!.value = { title: "Shared" }
    await flushPromises()
    const editor = wrapper.getComponent({ name: "ConsoleMarkdownEditor" })
    const previewBody = () => (wrapper.findComponent({ name: "ConsoleDocumentPreview" }).props("document") as { body?: string }).body
    const typed = async (body: string) => {
      roomBody.value = body
      editor.vm.$emit("change")
      await new Promise(resolve => setTimeout(resolve, 300))
      await flushPromises()
    }

    roomBody.value = "Typed before the preview opened"
    route.current.query = { preview: null }
    await flushPromises()
    expect(previewBody()).toBe("Typed before the preview opened")
    await typed("Typed with the preview open")
    expect(previewBody()).toBe("Typed with the preview open")

    route.current.query = {}
    await flushPromises()
    expect(wrapper.findComponent({ name: "ConsoleDocumentPreview" }).exists()).toBe(false)
    // Typing here and another person's edit in the room both change the body while the preview is closed.
    await typed("Typed while the preview was closed")
    roomBody.value = "Typed while the preview was closed, then edited by Ben"
    route.current.query = { preview: null }
    await flushPromises()
    expect(previewBody()).toBe("Typed while the preview was closed, then edited by Ben")
    // Nothing was saved or published to show it.
    expect(roomSave).not.toHaveBeenCalled()
  })
})
