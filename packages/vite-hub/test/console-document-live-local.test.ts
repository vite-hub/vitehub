// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils"
import { defineComponent, h, ref, shallowRef } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createConsoleDocumentsClient } from "../src/console/runtime/client/documents"
import { readConsoleLocalDraft } from "../src/console/runtime/client/preview"
import ConsoleDocumentEditor from "../src/console/runtime/components/console-document-editor.vue"

import type { ConsoleDocument, ConsoleDocumentCollection } from "../src/console/runtime/client/documents"

/** The body the live room editor holds now: the person keeps typing after the room took its save. */
const roomBody = vi.hoisted(() => ({ value: "" }))
const roomSave = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("vue-router", () => ({
  onBeforeRouteLeave: vi.fn(),
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock("../src/console/runtime/components/console-markdown-editor.vue", () => ({
  default: { name: "ConsoleMarkdownEditor", props: ["modelValue", "live"], emits: ["update:modelValue"], setup: (_props: unknown, { expose }: { expose: (exposed: object) => void }) => {
    expose({ commit: async () => undefined, markdown: async () => roomBody.value })
    return () => null
  } },
}))
vi.mock("../src/console/runtime/client/live", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/live")>(),
  useConsoleLiveDocument: () => ({
    document: shallowRef({}),
    fields: shallowRef({ title: "Shared" }),
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
})

describe("Local only from a live room", () => {
  it("keeps the body typed after the room took its save", async () => {
    const client = { ...createConsoleDocumentsClient("", "content"), get: vi.fn(async () => structuredClone(shared)) }
    const wrapper = shallowMount(ConsoleDocumentEditor, {
      props: { changes: 0, client, collection, documentId: "hello", setup: { live: { definition: "content" } } },
      global: { stubs: { ...stubs, ConsoleMarkdownEditor: false } },
    })
    wrappers.push(wrapper)
    await flushPromises()
    roomBody.value = "Saved by the room, and typed after the save"
    const menu = wrapper.findAllComponents(UDropdownMenu).find(item => JSON.stringify(item.props("items")).includes("Local only"))!
    const items = (menu.props("items") as Array<Array<{ label: string, onUpdateChecked?: () => void }>>).flat()
    items.find(item => item.label === "Local only")!.onUpdateChecked!()
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
})
