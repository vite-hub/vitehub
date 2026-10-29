// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils"
import { defineComponent, h, ref } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createConsoleDocumentsClient } from "../src/console/runtime/client/documents"
import ConsoleDocumentEditor from "../src/console/runtime/components/console-document-editor.vue"
import ConsoleDocumentDiff from "../src/console/runtime/components/console-document-diff.vue"

import type { ConsoleDocument, ConsoleDocumentCollection } from "../src/console/runtime/client/documents"

vi.mock("vue-router", () => ({
  onBeforeRouteLeave: vi.fn(),
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock("../src/console/runtime/components/console-markdown-editor.vue", () => ({ default: { render: () => null } }))
vi.mock("../src/console/runtime/client/presence", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/presence")>(),
  useConsoleDocumentPresence: () => ({
    claim: async () => true,
    holder: ref(null),
    mayWrite: ref(true),
    mode: ref("free"),
    others: ref([]),
    ownOtherTab: ref(false),
    presence: ref(null),
    unreachable: ref(false),
  }),
}))

const collection: ConsoleDocumentCollection = {
  access: { read: true, write: true, publish: true },
  format: "json",
  label: "Posts",
  name: "posts",
  path: "posts/*.json",
  schema: { type: "object", properties: { title: { type: "string" } } },
  titleField: "title",
}
const draft: ConsoleDocument = {
  body: "",
  collection: "posts",
  conflict: { published: "site-before-read" },
  data: { title: "My draft" },
  digest: "draft-digest",
  id: "hello",
  path: "posts/hello.json",
  revision: "draft-revision",
  state: "changed",
  updatedAt: null,
}
const site: ConsoleDocument = { ...draft, conflict: undefined, data: { title: "Site version" }, digest: "site-digest", state: "published" }
const saved: ConsoleDocument = { ...draft, conflict: undefined, digest: "saved-digest" }

const UButton = defineComponent({
  props: { label: String, disabled: Boolean, loading: Boolean },
  setup: props => () => h("button", { "data-label": props.label, disabled: props.disabled || props.loading }, props.label),
})
const UModal = defineComponent({
  props: { open: Boolean },
  setup: (props, { slots }) => () => props.open ? h("section", [slots.body?.(), slots.footer?.()]) : null,
})

const wrappers: Array<{ unmount(): void }> = []
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
})

async function mountEditor(published: () => Promise<ConsoleDocument | null>, initial = draft) {
  const client = {
    ...createConsoleDocumentsClient("", "content"),
    get: vi.fn(async (_collection: string, _id: string, ref?: "draft" | "published") => ref === "published" ? await published() : initial),
    save: vi.fn(async () => saved),
  }
  const wrapper = shallowMount(ConsoleDocumentEditor, {
    props: { changes: 0, client, collection, documentId: "hello" },
    global: {
      stubs: {
        ConsolePageHeader: { template: "<header><slot name='right' /></header>" },
        ConsoleStatus: { props: ["label"], template: "<span>{{ label }}</span>" },
        UButton,
        UModal,
        UTooltip: { template: "<slot />" },
        UFieldGroup: { template: "<slot />" },
        UDropdownMenu: true, UEmpty: true, UFormField: true, UInputDate: true, UInputTime: true,
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  await wrapper.get("header button").trigger("click")
  await flushPromises()
  return { wrapper, client }
}

describe("Published conflict comparison", () => {
  it.each(["The site is temporarily unavailable.", "The published document has invalid fields."])("blocks resolution and preserves the error: %s", async (message) => {
    const published = vi.fn<() => Promise<ConsoleDocument | null>>()
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValueOnce(site)
    const { wrapper, client } = await mountEditor(published)

    expect(wrapper.get('[role="alert"]').text()).toContain(message)
    expect(wrapper.text()).not.toContain("The site no longer has")
    expect(wrapper.findComponent(ConsoleDocumentDiff).exists()).toBe(false)
    expect(wrapper.find('[data-label="Use the site version"]').exists()).toBe(false)
    const keep = wrapper.get('[data-label="Keep my draft"]')
    expect(keep.attributes("disabled")).toBeDefined()
    await keep.trigger("click")
    expect(client.save).not.toHaveBeenCalled()

    await wrapper.get('[data-label="Retry"]').trigger("click")
    await flushPromises()
    expect(published).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.getComponent(ConsoleDocumentDiff).props()).toMatchObject({ before: { body: site.body, data: site.data } })
    await wrapper.get('[data-label="Keep my draft"]').trigger("click")
    await flushPromises()
    expect(client.save).toHaveBeenCalledWith("posts", "hello", expect.objectContaining({ data: draft.data, ifPublishedDigest: site.digest }))
  })

  it("blocks resolution while the site read is pending", async () => {
    let resolve!: (value: ConsoleDocument) => void
    const published = new Promise<ConsoleDocument>(done => { resolve = done })
    const { wrapper, client } = await mountEditor(() => published)
    expect(wrapper.get('[data-label="Keep my draft"]').attributes("disabled")).toBeDefined()
    expect(wrapper.findComponent(ConsoleDocumentDiff).exists()).toBe(false)
    expect(client.save).not.toHaveBeenCalled()
    resolve(site)
    await flushPromises()
    expect(wrapper.get('[data-label="Keep my draft"]').attributes("disabled")).toBeUndefined()
    await wrapper.get('[data-label="Use the site version"]').trigger("click")
    await flushPromises()
    expect(client.save).toHaveBeenCalledWith("posts", "hello", expect.objectContaining({ data: site.data, ifPublishedDigest: site.digest }))
  })

  it("discards an earlier comparison when reopening fails to read the site", async () => {
    const published = vi.fn<() => Promise<ConsoleDocument | null>>()
      .mockResolvedValueOnce(site)
      .mockRejectedValueOnce(new Error("The site is unavailable."))
    const { wrapper, client } = await mountEditor(published)
    expect(wrapper.find('[data-label="Use the site version"]').exists()).toBe(true)
    await wrapper.get('[data-label="Keep editing"]').trigger("click")
    await wrapper.get("header button").trigger("click")
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain("The site is unavailable.")
    expect(wrapper.findComponent(ConsoleDocumentDiff).exists()).toBe(false)
    expect(wrapper.find('[data-label="Use the site version"]').exists()).toBe(false)
    expect(wrapper.get('[data-label="Keep my draft"]').attributes("disabled")).toBeDefined()
    expect(client.save).not.toHaveBeenCalled()
  })

  it.each(["site-before-read", null])("confirms deletion with a successful null read (known digest: %s)", async (knownDigest) => {
    const published = vi.fn(async () => null)
    const { wrapper, client } = await mountEditor(published, { ...draft, conflict: { published: knownDigest } })
    expect(published).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain("The site no longer has")
    expect(wrapper.getComponent(ConsoleDocumentDiff).props()).toMatchObject({ before: null })
    await wrapper.get('[data-label="Keep my draft"]').trigger("click")
    await flushPromises()
    expect(client.save).toHaveBeenCalledWith("posts", "hello", expect.objectContaining({ data: draft.data, ifPublishedDigest: null }))
  })
})
