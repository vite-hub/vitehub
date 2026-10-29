// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils"
import { defineComponent, h, ref } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createConsoleDocumentsClient } from "../src/console/runtime/client/documents"
import { readConsoleLocalDraft, writeConsoleLocalDraft } from "../src/console/runtime/client/preview"
import { ConsoleRequestError } from "../src/console/runtime/client/request"
import { useConsoleToast } from "../src/console/runtime/client/toast"
import ConsoleDocumentEditor from "../src/console/runtime/components/console-document-editor.vue"
import ConsoleDocumentDiff from "../src/console/runtime/components/console-document-diff.vue"

import type { ConsoleDocument, ConsoleDocumentCollection } from "../src/console/runtime/client/documents"

const claimLease = vi.hoisted(() => vi.fn(async () => true))

vi.mock("vue-router", () => ({
  onBeforeRouteLeave: vi.fn(),
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock("../src/console/runtime/components/console-markdown-editor.vue", () => ({
  default: { name: "ConsoleMarkdownEditor", props: ["modelValue"], emits: ["update:modelValue"], setup: (_props: unknown, { expose }: { expose: (exposed: object) => void }) => {
    expose({ commit: async () => undefined })
    return () => null
  } },
}))
vi.mock("../src/console/runtime/client/presence", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/presence")>(),
  useConsoleDocumentPresence: () => ({
    acquire: claimLease,
    claim: claimLease,
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
  sessionStorage.clear()
  claimLease.mockClear()
})

const stubs = {
  ConsolePageHeader: { template: "<header><slot name='right' /></header>" },
  ConsoleStatus: { props: ["label"], template: "<span>{{ label }}</span>" },
  UButton,
  UModal,
  UTooltip: { template: "<slot />" },
  UFieldGroup: { template: "<slot />" },
  UDropdownMenu: true, UEmpty: true, UFormField: true, UInputDate: true, UInputTime: true,
}

async function mountEditor(published: () => Promise<ConsoleDocument | null>, initial = draft) {
  const client = {
    ...createConsoleDocumentsClient("", "content"),
    get: vi.fn(async (_collection: string, _id: string, ref?: "draft" | "published") => ref === "published" ? await published() : initial),
    save: vi.fn(async () => saved),
  }
  const wrapper = shallowMount(ConsoleDocumentEditor, {
    props: { changes: 0, client, collection, documentId: "hello" },
    global: { stubs },
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

const conflictError = (ref?: "published") => new ConsoleRequestError(409, "Conflict", { code: "WORKSPACE_CONFLICT", details: ref ? { ref, documents: [] } : {} })

/**
 * A store with the checks of the Content store: a save names the shared draft digest it replaces and, after a site
 * change, the site digest it compared. A collection without a live room, so saves pass this tab's edit lease.
 */
function conflictStore() {
  let version = 0
  const store = {
    site: { ...site, data: { title: "Site from Git" }, digest: "site-2" } as ConsoleDocument,
    shared: { ...draft, data: { title: "Shared, saved by someone else" }, digest: "shared-2", conflict: { published: "site-1" } } as ConsoleDocument,
    move(data: Record<string, unknown>) {
      store.shared = { ...store.shared, data, digest: `shared-moved-${++version}` }
    },
  }
  const client = {
    ...createConsoleDocumentsClient("", "content"),
    get: vi.fn(async (_collection: string, _id: string, ref?: "draft" | "published") => structuredClone(ref === "published" ? store.site : store.shared)),
    save: vi.fn(async (_collection: string, _id: string, input: { data?: Record<string, unknown>, ifDigest?: string | null, ifPublishedDigest?: string | null, live?: boolean }) => {
      if (input.ifDigest !== store.shared.digest) throw conflictError()
      if (input.ifPublishedDigest !== undefined && input.ifPublishedDigest !== store.site.digest) throw conflictError()
      store.shared = { ...store.shared, conflict: input.ifPublishedDigest === undefined ? store.shared.conflict : undefined, data: input.data ?? {}, digest: `shared-saved-${++version}` }
      return structuredClone(store.shared)
    }),
    publish: vi.fn(async (_collection: string, documents: Array<{ digest: string | null, id: string }>) => {
      if (documents[0]?.digest !== store.shared.digest) throw conflictError()
      if (store.shared.conflict) throw conflictError("published")
      store.site = { ...store.shared, conflict: undefined, state: "published" }
      return { documents: [{ id: "hello" }] }
    }),
  }
  return { store, client }
}

const privateEdit = { title: "PRIVATE local edit" }

/** Opens the editor in Local only, with private edits that started from an older shared draft, then reviews Publish shared draft. */
async function reviewSharedPublish() {
  const { store, client } = conflictStore()
  writeConsoleLocalDraft(sessionStorage, "posts", "hello", { base: "shared-1", start: { body: "", data: { title: "Shared start" } }, version: { body: "", data: privateEdit } })
  const wrapper = shallowMount(ConsoleDocumentEditor, { props: { changes: 0, client, collection, documentId: "hello" }, global: { stubs } })
  wrappers.push(wrapper)
  await flushPromises()
  await wrapper.get('header [data-label="Publish shared draft"]').trigger("click")
  await flushPromises()
  // The review shows the shared draft. It also changed on the site, so Publish opens the comparison and publishes nothing.
  expect(wrapper.getComponent(ConsoleDocumentDiff).props()).toMatchObject({ after: { body: "", data: store.shared.data } })
  await wrapper.get('section [data-label="Publish shared draft"]').trigger("click")
  await flushPromises()
  expect(client.publish).not.toHaveBeenCalled()
  return { store, client, wrapper }
}

function savedPrivateData(client: ReturnType<typeof conflictStore>["client"]): boolean {
  return client.save.mock.calls.some(([, , input]) => input.data?.title === privateEdit.title)
}

describe("Publish shared draft from Local only, when the site changed too", () => {
  it("compares the reviewed shared draft, never the private edits", async () => {
    const { store, wrapper, client } = await reviewSharedPublish()
    expect(wrapper.getComponent(ConsoleDocumentDiff).props()).toEqual(expect.objectContaining({ before: { body: "", data: store.site.data }, after: { body: "", data: store.shared.data } }))
    expect(wrapper.text()).toContain("Your local edits are not part of it")
    expect(wrapper.find('[data-label="Keep my draft"]').exists()).toBe(false)
    expect(wrapper.find('[data-label="Keep the shared draft"]').exists()).toBe(true)
    expect(client.save).not.toHaveBeenCalled()
  })

  it("keeps the shared draft with the lease and both digests, then publishes it, and the private edits stay in the tab", async () => {
    const { store, wrapper, client } = await reviewSharedPublish()
    const reviewed = store.shared
    await wrapper.get('[data-label="Keep the shared draft"]').trigger("click")
    await flushPromises()
    expect(claimLease).toHaveBeenCalled()
    expect(client.save).toHaveBeenCalledOnce()
    const [, , input] = client.save.mock.calls[0]!
    expect(input).toMatchObject({ data: reviewed.data, ifDigest: reviewed.digest, ifPublishedDigest: "site-2" })
    expect(input).not.toHaveProperty("live")
    // The review opens again with the kept shared draft, and publishing it now succeeds.
    expect(wrapper.getComponent(ConsoleDocumentDiff).props()).toMatchObject({ after: { body: "", data: reviewed.data } })
    await wrapper.get('section [data-label="Publish shared draft"]').trigger("click")
    await flushPromises()
    expect(client.publish).toHaveBeenLastCalledWith("posts", [{ digest: store.shared.digest, id: "hello" }])
    expect(store.site.data).toEqual(reviewed.data)
    expect(savedPrivateData(client)).toBe(false)
    expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")?.version.data).toEqual(privateEdit)
    expect(wrapper.find('header [data-label="Publish shared draft"]').exists()).toBe(true)
  })

  it("uses the site version for the shared draft only", async () => {
    const { store, wrapper, client } = await reviewSharedPublish()
    await wrapper.get('[data-label="Use the site version"]').trigger("click")
    await flushPromises()
    expect(client.save).toHaveBeenCalledOnce()
    expect(client.save.mock.calls[0]![2]).toMatchObject({ data: { title: "Site from Git" }, ifDigest: "shared-2", ifPublishedDigest: "site-2" })
    expect(store.shared.data).toEqual({ title: "Site from Git" })
    expect(savedPrivateData(client)).toBe(false)
    expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")?.version.data).toEqual(privateEdit)
  })

  it("saves nothing when the person keeps editing", async () => {
    const { wrapper, client } = await reviewSharedPublish()
    await wrapper.get('[data-label="Keep editing"]').trigger("click")
    await flushPromises()
    expect(client.save).not.toHaveBeenCalled()
    expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")?.version.data).toEqual(privateEdit)
  })

  it.each([
    ["a newer shared save", (store: ReturnType<typeof conflictStore>["store"]) => store.move({ title: "Shared, saved again" })],
    ["another site change", (store: ReturnType<typeof conflictStore>["store"]) => { store.site = { ...store.site, digest: "site-3" } }],
  ])("overwrites nothing after %s while comparing, and reviews again", async (_name, race) => {
    const { store, wrapper, client } = await reviewSharedPublish()
    race(store)
    const before = structuredClone(store.shared)
    await wrapper.get('[data-label="Keep the shared draft"]').trigger("click")
    await flushPromises()
    expect(client.save.mock.settledResults[0]?.type).toBe("rejected")
    expect(store.shared).toEqual(before)
    expect(wrapper.find('[data-label="Keep the shared draft"]').exists()).toBe(false)
    expect(wrapper.getComponent(ConsoleDocumentDiff).props()).toMatchObject({ after: { body: "", data: store.shared.data } })
    expect(savedPrivateData(client)).toBe(false)
  })

  it("saves the private edits only through Apply, after its own comparison with the newer shared draft", async () => {
    const { store, wrapper, client } = await reviewSharedPublish()
    await wrapper.get('[data-label="Keep the shared draft"]').trigger("click")
    await flushPromises()
    await wrapper.get('[data-label="Cancel"]').trigger("click")
    await wrapper.get('[data-label="Apply to shared draft"]').trigger("click")
    await flushPromises()
    // The private edits started from shared-1, so Apply refuses and compares first.
    expect(client.save.mock.settledResults.at(-1)?.type).toBe("rejected")
    expect(store.shared.data.title).not.toBe(privateEdit.title)
    // Only an explicit choice in that comparison saves them, over the exact shared draft it showed.
    const compared = store.shared.digest
    await wrapper.get('[data-label="Overwrite with mine"]').trigger("click")
    await flushPromises()
    expect(client.save).toHaveBeenLastCalledWith("posts", "hello", expect.objectContaining({ data: privateEdit, ifDigest: compared }))
    expect(store.shared.data).toEqual(privateEdit)
    expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")).toBeUndefined()
  })
})

/** The value of a form control. Browser types stay out of this test program. */
const valueOf = (element: unknown): unknown => Reflect.get(Object(element), "value")

/** A deferred result, so a test can type while a request is in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe("Apply local edits while the person keeps typing", () => {
  const markdown: ConsoleDocumentCollection = { ...collection, format: "markdown", path: "posts/*.md" }
  const shared: ConsoleDocument = { ...draft, conflict: undefined, body: "Shared body", data: { title: "Shared" }, digest: "shared-1", path: "posts/hello.md" }
  const applied = { body: "Applied body", data: { title: "Applied title" } }
  const typed = { body: "Typed during apply", data: { title: "Typed title" } }

  async function openLocal() {
    writeConsoleLocalDraft(sessionStorage, "posts", "hello", { base: "shared-1", start: { body: shared.body, data: shared.data }, version: applied })
    const request = deferred<ConsoleDocument>()
    const client = {
      ...createConsoleDocumentsClient("", "content"),
      get: vi.fn(async () => structuredClone(shared)),
      save: vi.fn((_collection: string, _id: string, _input: { body?: string, data?: Record<string, unknown>, ifDigest?: string | null }) => request.promise),
    }
    const mount = () => {
      const wrapper = shallowMount(ConsoleDocumentEditor, { props: { changes: 0, client, collection: markdown, documentId: "hello" }, global: { stubs: { ...stubs, ConsoleMarkdownEditor: false } } })
      wrappers.push(wrapper)
      return wrapper
    }
    const wrapper = mount()
    await flushPromises()
    await wrapper.get('article [data-label="Apply to shared draft"]').trigger("click")
    await flushPromises()
    expect(client.save).toHaveBeenCalledOnce()
    // The person keeps typing in the title and the body while the save is in flight.
    await wrapper.get("textarea").setValue(typed.data.title)
    wrapper.getComponent({ name: "ConsoleMarkdownEditor" }).vm.$emit("update:modelValue", typed.body)
    await flushPromises()
    return { client, request, wrapper, mount }
  }

  function sentEdits(client: Awaited<ReturnType<typeof openLocal>>["client"]) {
    return client.save.mock.calls.map(([, , input]) => ({ body: input.body, data: input.data }))
  }

  it("saves only the version it sent, and keeps later edits local, stored, and unsaved", async () => {
    const { client, request, wrapper, mount } = await openLocal()
    request.resolve({ ...shared, ...structuredClone(applied), digest: "shared-2" })
    await flushPromises()

    expect(sentEdits(client)).toEqual([applied])
    expect(valueOf(wrapper.get("textarea").element)).toBe(typed.data.title)
    expect(wrapper.getComponent({ name: "ConsoleMarkdownEditor" }).props("modelValue")).toBe(typed.body)
    expect(wrapper.text()).toContain("Local edits · not saved")
    expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")).toEqual({ base: "shared-2", start: applied, version: typed })

    // A reload opens the same local edits.
    wrapper.unmount()
    const reloaded = mount()
    await flushPromises()
    expect(valueOf(reloaded.get("textarea").element)).toBe(typed.data.title)
    expect(reloaded.text()).toContain("Local edits · not saved")

    // The next Apply sends them over the shared draft that the first one saved.
    client.save.mockResolvedValueOnce({ ...shared, ...structuredClone(typed), digest: "shared-3" })
    await reloaded.get('article [data-label="Apply to shared draft"]').trigger("click")
    await flushPromises()
    expect(client.save).toHaveBeenLastCalledWith("posts", "hello", expect.objectContaining({ ...typed, ifDigest: "shared-2" }))
    expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")).toBeUndefined()
  })

  it("keeps every edit local after a failed save", async () => {
    const { client, request, wrapper } = await openLocal()
    request.reject(new ConsoleRequestError(500, "Server Error", { code: "INTERNAL" }))
    await flushPromises()
    expect(sentEdits(client)).toEqual([applied])
    expect(valueOf(wrapper.get("textarea").element)).toBe(typed.data.title)
    expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")).toEqual({ base: "shared-1", start: { body: shared.body, data: shared.data }, version: typed })
    expect(wrapper.text()).toContain("Local edits · not saved")
  })

  it("keeps every edit local after a conflict, and overwrites only with the latest edits on request", async () => {
    const { client, request, wrapper } = await openLocal()
    const theirs = { ...shared, data: { title: "Someone else" }, digest: "shared-other" }
    client.get.mockResolvedValue(structuredClone(theirs))
    request.reject(conflictError())
    await flushPromises()
    expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")?.version).toEqual(typed)
    expect(wrapper.getComponent(ConsoleDocumentDiff).props()).toMatchObject({ after: typed })
    client.save.mockResolvedValueOnce({ ...theirs, ...structuredClone(typed), digest: "shared-3" })
    await wrapper.get('[data-label="Overwrite with mine"]').trigger("click")
    await flushPromises()
    expect(client.save).toHaveBeenLastCalledWith("posts", "hello", expect.objectContaining({ ...typed, ifDigest: "shared-other" }))
    expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")).toBeUndefined()
  })

  it("leaves Local only when nothing changed during the save", async () => {
    writeConsoleLocalDraft(sessionStorage, "posts", "hello", { base: "shared-1", start: { body: shared.body, data: shared.data }, version: applied })
    const client = {
      ...createConsoleDocumentsClient("", "content"),
      get: vi.fn(async () => structuredClone(shared)),
      save: vi.fn(async () => ({ ...shared, ...structuredClone(applied), digest: "shared-2" })),
    }
    const wrapper = shallowMount(ConsoleDocumentEditor, { props: { changes: 0, client, collection: markdown, documentId: "hello" }, global: { stubs: { ...stubs, ConsoleMarkdownEditor: false } } })
    wrappers.push(wrapper)
    await flushPromises()
    await wrapper.get('article [data-label="Apply to shared draft"]').trigger("click")
    await flushPromises()
    expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")).toBeUndefined()
    expect(wrapper.text()).not.toContain("Local edits · not saved")
    expect(valueOf(wrapper.get("textarea").element)).toBe(applied.data.title)
  })
})

describe("Local only edits on the third review", () => {
  it("keeps the local edits of a singleton when its shared draft is gone", async () => {
    const settings: ConsoleDocumentCollection = { ...collection, kind: "singleton", label: "Settings", name: "settings", path: "settings.json" }
    writeConsoleLocalDraft(sessionStorage, "settings", "settings", { base: "shared-1", start: { body: "", data: { title: "Shared" } }, version: { body: "", data: privateEdit } })
    const client = {
      ...createConsoleDocumentsClient("", "content"),
      get: vi.fn(async () => null),
      list: vi.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
      save: vi.fn(async () => saved),
    }
    const wrapper = shallowMount(ConsoleDocumentEditor, { props: { changes: 0, client, collection: settings, documentId: "settings" }, global: { stubs } })
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.getComponent({ name: "ConsoleSchemaForm" }).props("modelValue")).toEqual(privateEdit)
    expect(wrapper.text()).toContain("Local edits · not saved")
    expect(readConsoleLocalDraft(sessionStorage, "settings", "settings")?.version.data).toEqual(privateEdit)
    expect(client.save).not.toHaveBeenCalled()
    // The recovery actions show for a singleton too.
    expect(wrapper.text()).toContain("The shared draft was deleted after your local edits started")
    expect(wrapper.get('[data-label="Apply to shared draft"]').attributes("disabled")).toBeUndefined()
    expect(wrapper.get('[data-label="Copy"]').attributes("aria-label")).toBe("Copy your local edits")
  })

  for (const [name, listed] of [["deleted from the draft", "deleted"], ["gone from the draft and the site", undefined]] as const) {
    it(`keeps local edits reachable, and creates nothing on its own, when the shared draft is ${name}`, async () => {
      writeConsoleLocalDraft(sessionStorage, "posts", "hello", { base: "shared-1", start: { body: "Shared body", data: { title: "Shared" } }, version: { body: "PRIVATE body", data: privateEdit } })
      const recreated: ConsoleDocument = { ...saved, body: "PRIVATE body", data: privateEdit, digest: "recreated" }
      const client = {
        ...createConsoleDocumentsClient("", "content"),
        get: vi.fn(async () => null),
        list: vi.fn(async () => ({ items: listed ? [{ ...draft, state: listed }] : [], nextCursor: null, total: listed ? 1 : 0 })),
        publish: vi.fn(),
        // The store refuses a save that names a digest of a draft that no longer exists.
        save: vi.fn(async (_collection: string, _id: string, input: { ifDigest?: string | null }) => {
          if (input.ifDigest !== null) throw new ConsoleRequestError(409, "Conflict", { code: "WORKSPACE_CONFLICT", details: {} })
          return recreated
        }),
      }
      const menu = defineComponent({ name: "UDropdownMenu", props: { items: { type: Array, default: () => [] } }, setup: (_props, { slots }) => () => h("div", slots.default?.()) })
      const posts: ConsoleDocumentCollection = { ...collection, format: "markdown", path: "posts/*.md" }
      const wrapper = shallowMount(ConsoleDocumentEditor, { props: { changes: 0, client, collection: posts, documentId: "hello" }, global: { stubs: { ...stubs, ConsoleMarkdownEditor: false, UDropdownMenu: menu } } })
      wrappers.push(wrapper)
      await flushPromises()

      // The editor, its banner, and the editing menu stay, instead of the empty state that hid them.
      expect(wrapper.findComponent({ name: "UEmpty" }).exists()).toBe(false)
      expect(wrapper.getComponent({ name: "ConsoleSchemaForm" }).props("modelValue")).toEqual(privateEdit)
      expect(wrapper.getComponent({ name: "ConsoleMarkdownEditor" }).props("modelValue")).toBe("PRIVATE body")
      expect(wrapper.text()).toContain("The shared draft was deleted after your local edits started")
      expect(wrapper.findAllComponents(menu).some(item => JSON.stringify(item.props("items")).includes("Local only"))).toBe(true)
      expect(wrapper.find('[aria-label="Editing: Local only"]').exists()).toBe(true)
      // Nothing to publish without a shared draft.
      expect(wrapper.find('[data-label="Publish shared draft"]').exists()).toBe(false)
      expect(wrapper.find('[data-label="Publish deletion"]').exists()).toBe(false)
      expect(wrapper.get('[data-label="Discard…"]').attributes("disabled")).toBeUndefined()
      expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")?.version).toEqual({ body: "PRIVATE body", data: privateEdit })

      // Apply compares first: the deleted draft is not created again until the person chooses it.
      await wrapper.get('[data-label="Apply to shared draft"]').trigger("click")
      await flushPromises()
      expect(client.save).toHaveBeenCalledOnce()
      expect(client.save.mock.calls[0]![2]).toMatchObject({ ifDigest: "shared-1" })
      expect(wrapper.text()).toContain("Local edits · not saved")
      await wrapper.get('section [data-label="Create again from mine"]').trigger("click")
      await flushPromises()
      expect(client.save).toHaveBeenCalledTimes(2)
      expect(client.save.mock.calls[1]![2]).toMatchObject({ body: "PRIVATE body", data: privateEdit, ifDigest: null })
      expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")).toBeUndefined()
      expect(client.publish).not.toHaveBeenCalled()
    })
  }

  it("says a pull request opened, not published, when Publish shared draft opens one", async () => {
    writeConsoleLocalDraft(sessionStorage, "posts", "hello", { base: "shared-1", start: { body: "", data: { title: "Shared" } }, version: { body: "", data: privateEdit } })
    const shared: ConsoleDocument = { ...draft, conflict: undefined, data: { title: "Shared" }, digest: "shared-1" }
    const client = {
      ...createConsoleDocumentsClient("", "content"),
      get: vi.fn(async (_collection: string, _id: string, ref?: "draft" | "published") => structuredClone(ref === "published" ? site : shared)),
      publish: vi.fn(async () => ({ documents: [{ id: "hello" }], pending: true, pullRequest: { number: 12, url: "https://github.com/acme/site/pull/12" } })),
    }
    const wrapper = shallowMount(ConsoleDocumentEditor, { props: { changes: 0, client, collection, documentId: "hello" }, global: { stubs } })
    wrappers.push(wrapper)
    await flushPromises()
    await wrapper.get('header [data-label="Publish shared draft"]').trigger("click")
    await flushPromises()
    await wrapper.get('section [data-label="Publish shared draft"]').trigger("click")
    await flushPromises()
    expect(client.publish).toHaveBeenCalledWith("posts", [{ digest: "shared-1", id: "hello" }])
    const toast = useConsoleToast().toasts.value.at(-1)
    expect(toast?.title).toContain("Pull request #12 opened")
    expect(toast?.title).not.toContain("published")
    expect(toast?.action?.label).toBe("Open pull request")
    expect(readConsoleLocalDraft(sessionStorage, "posts", "hello")?.version.data).toEqual(privateEdit)
  })
})
