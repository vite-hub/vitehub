// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils"
import { defineComponent, h, ref } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleTranslationsToDo, createConsoleDocumentsClient } from "../src/console/runtime/client/documents"
import { parseConsoleDocumentCollections } from "../src/console/runtime/definitions"
import ConsoleDocumentEditor from "../src/console/runtime/components/console-document-editor.vue"

import type { ConsoleDocument, ConsoleDocumentCollection } from "../src/console/runtime/client/documents"

const requestConsole = vi.hoisted(() => vi.fn<(path: string, options: { body?: unknown, query?: Record<string, unknown> }) => Promise<unknown>>(async () => null))
const route = vi.hoisted(() => ({ query: {} as Record<string, unknown> }))

vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(),
  requestConsole,
}))
vi.mock("vue-router", () => ({
  onBeforeRouteLeave: vi.fn(),
  onBeforeRouteUpdate: vi.fn(),
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock("../src/console/runtime/components/console-markdown-editor.vue", () => ({
  default: { name: "ConsoleMarkdownEditor", props: ["modelValue"], setup: (_props: unknown, { expose }: { expose: (exposed: object) => void }) => {
    expose({ commit: async () => undefined })
    return () => null
  } },
}))
vi.mock("../src/console/runtime/client/presence", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/presence")>(),
  useConsoleDocumentPresence: () => ({
    acquire: vi.fn(async () => true),
    claim: vi.fn(async () => true),
    holder: ref(null),
    input: vi.fn(),
    mayWrite: ref(true),
    mode: ref("free"),
    others: ref([]),
    ownOtherTab: ref(false),
    presence: ref(null),
    refresh: vi.fn(async () => undefined),
    resume: vi.fn(),
    unreachable: ref(false),
  }),
}))

afterEach(() => {
  requestConsole.mockClear()
  route.query = {}
})

/** The body of each Console request, by action. */
function sent(): Array<[unknown, unknown]> {
  return requestConsole.mock.calls.map(([, options]) => [options.query?.action, options.body])
}

describe("Console documents client with a locale", () => {
  it("reads and writes one document in its locale, and leaves lists and schedules alone", async () => {
    const client = createConsoleDocumentsClient("/api/_vitehub/console/documents", "content", "es")
    await client.get("docs", "guide")
    await client.get("docs", "guide", "published")
    await client.raw("docs", "guide")
    await client.save("docs", "guide", { body: "Hola.", data: { title: "Guía" }, ifDigest: null, session: "tab" })
    await client.remove("docs", "guide", "digest")
    await client.restore("docs", "guide", "revision", "digest")
    await client.revisions("docs", "guide")
    await client.session("docs", "guide", { action: "report", session: "tab" })
    await client.publish("docs", [{ digest: "digest", id: "guide" }])
    await client.list("docs")
    await client.schedule("docs", "2026-12-01T09:00:00.000Z", [{ digest: "digest", id: "guide" }])
    expect(sent()).toEqual([
      ["get", { collection: "docs", id: "guide", locale: "es" }],
      ["get", { collection: "docs", id: "guide", ref: "published", locale: "es" }],
      ["raw", { collection: "docs", id: "guide", locale: "es" }],
      ["save", { collection: "docs", id: "guide", body: "Hola.", data: { title: "Guía" }, ifDigest: null, session: "tab", locale: "es" }],
      ["remove", { collection: "docs", id: "guide", ifDigest: "digest", locale: "es" }],
      ["restore", { collection: "docs", id: "guide", ifDigest: "digest", revision: "revision", locale: "es" }],
      ["revisions", { collection: "docs", id: "guide", locale: "es" }],
      ["session", { collection: "docs", id: "guide", action: "report", session: "tab", locale: "es" }],
      ["publish", { collection: "docs", expect: [{ digest: "digest", id: "guide", locale: "es" }] }],
      ["list", { collection: "docs" }],
      ["schedule", { at: "2026-12-01T09:00:00.000Z", collection: "docs", expect: [{ digest: "digest", id: "guide" }] }],
    ])
  })

  it("sends no locale without one", async () => {
    const client = createConsoleDocumentsClient("/api/_vitehub/console/documents", "content")
    await client.get("docs", "guide")
    await client.publish("docs", [{ digest: "digest", id: "guide" }])
    expect(sent()).toEqual([
      ["get", { collection: "docs", id: "guide" }],
      ["publish", { collection: "docs", expect: [{ digest: "digest", id: "guide" }] }],
    ])
  })
})

describe("Collections with locales", () => {
  it("keeps the locales of a collection, source locale first", () => {
    const base = { access: {}, label: "Docs", name: "docs", path: "docs/{locale}/**/*.md", schema: { type: "object" } }
    expect(parseConsoleDocumentCollections([{ ...base, locales: ["en", "es"] }])[0]).toMatchObject({ locales: ["en", "es"] })
    expect(parseConsoleDocumentCollections([base])[0]).not.toHaveProperty("locales")
    expect(parseConsoleDocumentCollections([{ ...base, locales: [] }])[0]).not.toHaveProperty("locales")
    expect(parseConsoleDocumentCollections([{ ...base, locales: ["en", 1] }])[0]).not.toHaveProperty("locales")
  })

  it("lists only the translations that need work", () => {
    expect(consoleTranslationsToDo({ es: "stale", fr: "missing", de: "current" })).toEqual([
      { label: "ES out of date", locale: "es", tone: "warning" },
      { label: "FR missing", locale: "fr", tone: "neutral" },
    ])
    expect(consoleTranslationsToDo(undefined)).toEqual([])
  })
})

describe("Editing a translation", () => {
  const collection: ConsoleDocumentCollection = {
    access: { read: true, write: true, publish: true },
    format: "json",
    label: "Docs",
    locales: ["en", "es", "fr"],
    name: "docs",
    path: "docs/{locale}/**/*.json",
    schema: { type: "object", properties: { title: { type: "string" } } },
    titleField: "title",
  }
  const source: ConsoleDocument = {
    body: "",
    collection: "docs",
    data: { title: "Guide" },
    digest: "source-digest",
    id: "guide",
    locale: "en",
    path: "docs/en/guide.json",
    revision: "source-revision",
    state: "draft",
    translations: { es: "missing", fr: "stale" },
    updatedAt: null,
  }
  const stubs = {
    ConsolePageHeader: { template: "<header><slot name='title-trailing' /><slot name='right' /></header>" },
    ConsoleStatus: { props: ["label"], template: "<span class='status'>{{ label }}</span>" },
    RouterLink: defineComponent({
      props: { to: { type: Object, required: true } },
      setup: (props, { attrs, slots }) => () => h("a", { ...attrs, "data-to": JSON.stringify(props.to) }, slots.default?.()),
    }),
    UButton: defineComponent({ props: { label: String }, setup: props => () => h("button", { "data-label": props.label }, props.label) }),
    UTooltip: { template: "<slot />" },
    UFieldGroup: { template: "<slot />" },
    UDropdownMenu: true, UEmpty: true, UModal: true, UIcon: true,
  }

  function mountEditor(document: ConsoleDocument, locale?: string) {
    const client = {
      ...createConsoleDocumentsClient("", "content", locale),
      get: vi.fn(async () => document),
      save: vi.fn(async (_collection: string, _id: string, input: { data: Record<string, unknown>, ifDigest: string | null }) => ({
        ...source,
        data: input.data,
        digest: "es-digest",
        locale: "es",
        path: "docs/es/guide.json",
        translations: { es: "current" as const, fr: "stale" as const },
      })),
    }
    route.query = locale ? { locale } : {}
    const wrapper = shallowMount(ConsoleDocumentEditor, { props: { changes: 0, client, collection, documentId: "guide", ...(locale ? { locale } : {}) }, global: { stubs } })
    return { client, wrapper }
  }

  it("switches between locales, source locale first, with each translation state", async () => {
    const { wrapper } = mountEditor(source)
    await flushPromises()
    const links = wrapper.findAll("nav[aria-label='Locales'] a")
    expect(links.map(link => [link.text(), link.attributes("aria-label"), link.attributes("aria-current")])).toEqual([
      ["en", "English · Source", "page"],
      ["es", "Spanish · Not translated", undefined],
      ["fr", "French · Out of date", undefined],
    ])
    expect(JSON.parse(links[1]!.attributes("data-to")!)).toEqual({ query: { locale: "es" } })
    expect(wrapper.text()).not.toContain("Not translated yet")
    wrapper.unmount()
  })

  it("opens a missing translation with the source version and saves it in its locale on the first edit", async () => {
    vi.useFakeTimers()
    try {
      const { client, wrapper } = mountEditor({ ...source, fallback: true, state: undefined }, "es")
      await flushPromises()
      expect(wrapper.text()).toContain("Not translated yet · This is the English version. Your first edit saves the Spanish translation.")
      expect(wrapper.get("textarea").element.value).toBe("Guide")
      expect(JSON.parse(wrapper.get("nav a[aria-current='page']").attributes("data-to")!)).toEqual({ query: { locale: "es" } })
      expect(wrapper.find("button[data-label='Open English']").exists()).toBe(true)
      expect(client.save).not.toHaveBeenCalled()

      await wrapper.get("textarea").setValue("Guía")
      await vi.advanceTimersByTimeAsync(1_500)
      await flushPromises()
      expect(client.save).toHaveBeenCalledWith("docs", "guide", expect.objectContaining({ data: { title: "Guía" }, ifDigest: null }))
      expect(wrapper.text()).not.toContain("Not translated yet")
      expect(wrapper.get("nav a[aria-current='page']").attributes("aria-label")).toBe("Spanish · Up to date")
      wrapper.unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("says when the source changed after the translation", async () => {
    const { wrapper } = mountEditor({ ...source, data: { title: "Guide en français" }, digest: "fr-digest", locale: "fr", path: "docs/fr/guide.json" }, "fr")
    await flushPromises()
    expect(wrapper.text()).toContain("Out of date · The English version changed after this translation was made.")
    wrapper.unmount()
  })
})
