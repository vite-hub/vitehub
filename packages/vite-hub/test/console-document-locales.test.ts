// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils"
import { defineComponent, h, ref } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleTranslationsToDo, createConsoleDocumentsClient } from "../src/console/runtime/client/documents"
import { setConsoleProject } from "../src/console/runtime/client/project"
import { ConsoleRequestError } from "../src/console/runtime/client/request"
import { parseConsoleDocumentCollections } from "../src/console/runtime/definitions"
import ConsoleDocumentEditor from "../src/console/runtime/components/console-document-editor.vue"
import ConsoleDocumentDiff from "../src/console/runtime/components/console-document-diff.vue"

import type { ConsoleDocument, ConsoleDocumentCollection } from "../src/console/runtime/client/documents"

const requestConsole = vi.hoisted(() => vi.fn<(path: string, options: { body?: unknown, query?: Record<string, unknown> }) => Promise<unknown>>(async () => null))
const route = vi.hoisted(() => ({ path: "/content/docs/guide", query: {} as Record<string, unknown> }))

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
  setConsoleProject({ origin: "", base: "" })
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
    await client.save("docs", "guide", { body: "Hola.", data: { title: "Guía" }, ifDigest: null, session: "tab", sourceDigest: "sha256-a" })
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
      ["save", { collection: "docs", id: "guide", body: "Hola.", data: { title: "Guía" }, ifDigest: null, session: "tab", sourceDigest: "sha256-a", locale: "es" }],
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
    UDropdownMenu: true, UEmpty: true, UIcon: true,
    UModal: { props: ["open"], template: "<div v-if='open' class='modal'><slot name='body' /><slot name='footer' /></div>" },
  }

  function mountEditor(document: ConsoleDocument, locale?: string, current: ConsoleDocument = source) {
    const client = {
      ...createConsoleDocumentsClient("", "content", locale),
      get: vi.fn(async () => document),
      save: vi.fn(async (_collection: string, _id: string, input: { data: Record<string, unknown>, ifDigest: string | null, sourceDigest?: string }) => ({
        ...source,
        data: input.data,
        digest: `${locale}-digest`,
        locale,
        path: `docs/${locale}/guide.json`,
        // Only a save with the current source digest makes the French translation up to date.
        translations: { es: "current" as const, fr: input.sourceDigest === current.source?.digest ? "current" as const : "stale" as const },
      })),
    }
    const sourceClient = { ...createConsoleDocumentsClient("", "content"), get: vi.fn(async () => current) }
    route.query = locale ? { locale } : {}
    const wrapper = shallowMount(ConsoleDocumentEditor, { props: { changes: 0, client, collection, documentId: "guide", ...(locale ? { locale, sourceClient } : {}) }, global: { stubs } })
    return { client, sourceClient, wrapper }
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

  it.each(["", "https://app.example.com"])("keeps preview controls on the source locale, and only for a same-origin project, for project origin %j", async (origin) => {
    setConsoleProject({ origin, base: "" })
    const original = mountEditor(source)
    await flushPromises()
    // The preview frame shows pages of the Console origin, so a Console on another origin offers no preview.
    expect(original.wrapper.find("button[aria-label='Preview the page']").exists()).toBe(!origin)
    expect(original.wrapper.find("button[aria-label='Preview: open in the app']").exists()).toBe(false)
    original.wrapper.unmount()

    const translated = mountEditor({ ...source, locale: "es", path: "docs/es/guide.json", translations: { es: "current" } }, "es")
    await flushPromises()
    expect(translated.wrapper.find("button[aria-label^='Preview']").exists()).toBe(false)
    translated.wrapper.unmount()
  })

  it("opens a missing translation with the source version and saves it in its locale on the first edit", async () => {
    vi.useFakeTimers()
    try {
      const { client, wrapper } = mountEditor({ ...source, fallback: true, source: { digest: "sha256-a", path: "docs/en/guide.json" }, state: undefined }, "es")
      await flushPromises()
      expect(wrapper.text()).toContain("Not translated yet · This is the English version. Your first edit saves the Spanish translation.")
      expect(wrapper.get("textarea").element.value).toBe("Guide")
      expect(JSON.parse(wrapper.get("nav a[aria-current='page']").attributes("data-to")!)).toEqual({ query: { locale: "es" } })
      expect(wrapper.find("button[data-label='Open English']").exists()).toBe(true)
      expect(client.save).not.toHaveBeenCalled()

      await wrapper.get("textarea").setValue("Guía")
      await vi.advanceTimersByTimeAsync(1_500)
      await flushPromises()
      // The save records the source version the editor showed, even if the source changed since.
      expect(client.save).toHaveBeenCalledWith("docs", "guide", expect.objectContaining({ data: { title: "Guía" }, ifDigest: null, sourceDigest: "sha256-a" }))
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

  it.each(["Load theirs", "Overwrite with mine"])("compares a deleted translation as missing before %s", async (choice) => {
    vi.useFakeTimers()
    const translated = { ...source, data: { title: "Guía" }, digest: "es-digest", locale: "es", path: "docs/es/guide.json" }
    const { client, wrapper } = mountEditor(translated, "es")
    try {
      await flushPromises()
      client.get.mockResolvedValue({ ...source, fallback: true, source: { digest: "sha256-a", path: source.path }, state: undefined })
      client.save.mockRejectedValueOnce(new ConsoleRequestError(409, "Conflict", { code: "WORKSPACE_CONFLICT" }))
      await wrapper.get("textarea").setValue("Mi guía")
      await vi.advanceTimersByTimeAsync(1_500)
      await flushPromises()
      // An autosave pauses for comparison; the status button opens it.
      await wrapper.get("header [role='status'] button").trigger("click")
      await flushPromises()
      expect(wrapper.getComponent(ConsoleDocumentDiff).props()).toMatchObject({ before: null })
      expect(wrapper.text()).toContain("The saved version deleted this")

      await wrapper.get(`button[data-label='${choice}']`).trigger("click")
      await flushPromises()
      if (choice === "Overwrite with mine") {
        expect(client.save).toHaveBeenLastCalledWith("docs", "guide", expect.objectContaining({ data: { title: "Mi guía" }, ifDigest: null }))
      }
      else {
        expect(wrapper.text()).toContain("Not translated yet")
        await wrapper.get("textarea").setValue("Nueva guía")
        await vi.advanceTimersByTimeAsync(1_500)
        await flushPromises()
        expect(client.save).toHaveBeenLastCalledWith("docs", "guide", expect.objectContaining({ ifDigest: null, sourceDigest: "sha256-a" }))
      }
    }
    finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it("compares a deleted published translation as missing and keeps the translated draft", async () => {
    const translated = { ...source, conflict: { published: "es-published" }, data: { title: "Guía" }, digest: "es-digest", locale: "es", path: "docs/es/guide.json" }
    const { client, wrapper } = mountEditor(translated, "es")
    try {
      await flushPromises()
      client.get.mockResolvedValue({ ...source, fallback: true, state: "published" })
      await wrapper.get("header [role='status'] button").trigger("click")
      await flushPromises()
      expect(wrapper.getComponent(ConsoleDocumentDiff).props()).toMatchObject({ before: null })
      expect(wrapper.text()).toContain("The site no longer has this")
      expect(wrapper.find("button[data-label='Use the site version']").exists()).toBe(false)
      await wrapper.get("button[data-label='Keep my draft']").trigger("click")
      await flushPromises()
      expect(client.save).toHaveBeenCalledWith("docs", "guide", expect.objectContaining({ data: { title: "Guía" }, ifDigest: "es-digest", ifPublishedDigest: null }))
    }
    finally {
      wrapper.unmount()
    }
  })

  it("keeps a stale translation stale on edits, and marks it up to date after showing the current source", async () => {
    vi.useFakeTimers()
    try {
      const current = { ...source, data: { title: "Guide B" }, source: { digest: "sha256-b", path: "docs/en/guide.json" } }
      const french = { ...source, data: { title: "Guide en français" }, digest: "fr-digest", locale: "fr", path: "docs/fr/guide.json", source: { digest: "sha256-b", path: "docs/en/guide.json" } }
      const { client, sourceClient, wrapper } = mountEditor(french, "fr", current)
      await flushPromises()

      await wrapper.get("textarea").setValue("Guide en français, corrigé")
      await vi.advanceTimersByTimeAsync(1_500)
      await flushPromises()
      expect(client.save).toHaveBeenCalledTimes(1)
      expect(client.save.mock.calls[0]![2]).not.toHaveProperty("sourceDigest")
      expect(wrapper.text()).toContain("Out of date")

      await wrapper.get("button[data-label='Mark as up to date']").trigger("click")
      await flushPromises()
      expect(sourceClient.get).toHaveBeenCalledWith("docs", "guide")
      expect(wrapper.get(".modal pre").text()).toContain("Guide B")
      await wrapper.findAll(".modal button[data-label='Mark as up to date']").at(-1)!.trigger("click")
      await flushPromises()
      expect(client.save).toHaveBeenLastCalledWith("docs", "guide", expect.objectContaining({ data: { title: "Guide en français, corrigé" }, ifDigest: "fr-digest", sourceDigest: "sha256-b" }))
      expect(wrapper.find(".modal").exists()).toBe(false)
      expect(wrapper.text()).not.toContain("Out of date")
      wrapper.unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })
})
