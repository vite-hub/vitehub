// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent, h, reactive } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import ConsoleDocumentPreview from "../src/console/runtime/components/console-document-preview.vue"

import type { ConsoleDocumentPreview as PreviewToken, ConsoleDocumentsClient } from "../src/console/runtime/client/documents"
import type { ConsolePreviewDocument } from "../src/console/runtime/client/preview"

const UButton = defineComponent({
  props: { label: String, loading: Boolean },
  setup: props => () => h("button", { "data-loading": props.loading ? "" : undefined }, props.label),
})
// The happy-dom environment provides the document. Browser types stay local to this test.
const document: { body: { innerHTML: string }, querySelector(selector: string): unknown } = Reflect.get(globalThis, "document")
interface SubmittedForm { target: string, isConnected: boolean, querySelector(selector: string): { value: string } | null }
const formPrototype: { submit(): void } = Reflect.get(Reflect.get(globalThis, "HTMLFormElement"), "prototype")

const stubs = { UButton, UTooltip: { template: "<slot />" }, UIcon: true }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const expiresAt = () => new Date(Date.now() + 15 * 60_000).toISOString()
const tokenOf = (token: string): PreviewToken => ({ parameter: "vitehub-content-preview", token, expiresAt: expiresAt() })
const post = (title: string): ConsolePreviewDocument => ({ collection: "posts", id: "hello", data: { title }, body: "# Hi" })

/** The forms the preview submitted into its frames: which frame, and what they posted. */
const submitted: Array<{ target: string, value: unknown, connected: boolean }> = []
afterEach(() => {
  submitted.splice(0)
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.innerHTML = ""
})

/** Mounts the preview. `tokens` answers its token requests in order, before the first render asks. */
function setup(tokens: Array<Promise<PreviewToken>>, view: "draft" | "published" = "draft", textFields: string[] = []) {
  vi.spyOn(formPrototype, "submit").mockImplementation(function (this: SubmittedForm) {
    const input = this.querySelector("input")
    submitted.push({ target: this.target, value: JSON.parse(input?.value ?? "null"), connected: this.isConnected })
  })
  const preview = vi.fn<(collection: string, id: string) => Promise<PreviewToken>>()
  for (const token of tokens) preview.mockReturnValueOnce(token)
  const client = { preview } as unknown as ConsoleDocumentsClient
  // What the editor binds: the view as a v-model, the document on screen, and a reload counter.
  const state = reactive({ view, reloads: 0, document: post("First") })
  const Host = defineComponent(() => () => h(ConsoleDocumentPreview, {
    client,
    collection: { name: "posts", kind: "documents" },
    documentId: "hello",
    url: new URL("https://site.test/blog/hello"),
    document: state.document,
    textFields,
    local: false,
    reloads: state.reloads,
    overlay: false,
    view: state.view,
    "onUpdate:view": (next: "draft" | "published") => (state.view = next),
    viewport: "desktop",
  }))
  const wrapper = mount(Host, { attachTo: "body", global: { stubs } })
  return { wrapper, preview, state }
}

/** The frames in the page, as the person sees them. */
function frames(wrapper: ReturnType<typeof setup>["wrapper"]) {
  return wrapper.findAll("iframe").map(frame => ({
    name: frame.attributes("name")!,
    src: frame.attributes("src"),
    visible: !frame.classes().includes("invisible"),
  }))
}

/** Loads a frame the way a browser reports it: its own page, then a load event. */
async function load(wrapper: ReturnType<typeof setup>["wrapper"], name: string) {
  const element = wrapper.get(`iframe[name="${name}"]`).element
  // A page on another origin: the preview still shows the frame, it only cannot instrument it.
  Object.defineProperty(element, "contentWindow", { configurable: true, value: { location: { href: "https://site.test/blog/hello", origin: "https://elsewhere.test" } } })
  element.dispatchEvent(new Event("load"))
  await flushPromises()
}

const loading = (wrapper: ReturnType<typeof setup>["wrapper"]) => wrapper.get('[aria-label="Reload the preview"]').attributes("data-loading") !== undefined

describe("Console document preview renders", () => {
  it("drops a draft render whose token arrives after the switch to Published", async () => {
    const late = deferred<PreviewToken>()
    const { wrapper, state } = setup([late.promise])
    await flushPromises()
    await wrapper.get('[role="radio"]:nth-child(2)').trigger("click")
    expect(state.view).toBe("published")
    await flushPromises()
    const [published] = frames(wrapper)
    expect(frames(wrapper)).toEqual([{ name: published!.name, src: "https://site.test/blog/hello?vitehub-content-published=", visible: false }])

    late.resolve(tokenOf("late"))
    await flushPromises()
    expect(submitted).toEqual([])
    expect(frames(wrapper)).toEqual([published])
    expect(loading(wrapper)).toBe(true)

    await load(wrapper, published!.name)
    expect(frames(wrapper)).toEqual([{ ...published, visible: true }])
    expect(loading(wrapper)).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it("posts only the newest render when tokens answer out of order, and ignores a stale failure", async () => {
    const first = deferred<PreviewToken>()
    const second = deferred<PreviewToken>()
    const { wrapper, state } = setup([first.promise, second.promise])
    await flushPromises()
    state.reloads++
    await flushPromises()

    second.resolve(tokenOf("second"))
    await flushPromises()
    first.reject(new Error("The old token request failed."))
    await flushPromises()

    const [frame] = frames(wrapper)
    expect(frames(wrapper)).toHaveLength(1)
    expect(submitted).toEqual([{ target: frame!.name, value: { token: "second", document: post("First") }, connected: true }])
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    await load(wrapper, frame!.name)
    expect(frames(wrapper)).toEqual([{ ...frame, visible: true }])
    expect(loading(wrapper)).toBe(false)
  })

  it("renders rapid field edits once, with the latest version", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { wrapper, state } = setup([Promise.resolve(tokenOf("token"))])
    await flushPromises()
    const [initial] = frames(wrapper)
    await load(wrapper, initial!.name)
    submitted.splice(0)

    for (const title of ["S", "Se", "Sec", "Second"]) {
      state.document = post(title)
      await flushPromises()
      vi.advanceTimersByTime(100)
    }
    vi.advanceTimersByTime(350)
    await flushPromises()
    expect(submitted.map(entry => entry.value)).toEqual([{ token: "token", document: post("Second") }])
    // The shown page stays until the new one loads.
    expect(frames(wrapper).map(frame => frame.visible)).toEqual([true, false])
    await load(wrapper, frames(wrapper)[1]!.name)
    expect(frames(wrapper)).toHaveLength(1)
    expect(frames(wrapper)[0]!.visible).toBe(true)
  })

  it("submits nothing after unmount, and a reopened preview renders on its own", async () => {
    const late = deferred<PreviewToken>()
    const first = setup([late.promise])
    await flushPromises()
    first.wrapper.unmount()
    late.resolve(tokenOf("late"))
    await flushPromises()
    expect(submitted).toEqual([])
    expect(document.querySelector("form")).toBeNull()

    vi.restoreAllMocks()
    const reopened = setup([Promise.resolve(tokenOf("reopened"))])
    await flushPromises()
    const [frame] = frames(reopened.wrapper)
    expect(submitted).toEqual([{ target: frame!.name, value: { token: "reopened", document: post("First") }, connected: true }])
    await load(reopened.wrapper, frame!.name)
    expect(loading(reopened.wrapper)).toBe(false)
    reopened.wrapper.unmount()
  })

  it("shows the error page of a draft render as a failure with Retry, never as the Draft page", async () => {
    const { wrapper, preview } = setup([Promise.resolve(tokenOf("one")), Promise.resolve(tokenOf("two"))])
    await flushPromises()
    const [frame] = frames(wrapper)
    expect(submitted).toHaveLength(1)
    // The page the site answers when a redirect leaves it: same origin, so the preview reads its message.
    const element = wrapper.get(`iframe[name="${frame!.name}"]`).element
    const page = new (Reflect.get(globalThis, "DOMParser") as new () => { parseFromString(html: string, type: string): unknown })()
      .parseFromString('<!doctype html><html><head><meta name="vitehub-content-preview-error" content="The page redirects to https://other.test, which is another site."></head><body></body></html>', "text/html")
    const origin: string = Reflect.get(Reflect.get(globalThis, "location"), "origin")
    Object.defineProperty(element, "contentWindow", { configurable: true, value: { location: { href: `${origin}/blog/hello`, origin } } })
    Object.defineProperty(page, "location", { configurable: true, value: { pathname: "/blog/hello", search: "" } })
    Object.defineProperty(element, "contentDocument", { configurable: true, value: page })
    element.dispatchEvent(new Event("load"))
    await flushPromises()
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain("The page redirects to https://other.test, which is another site.")
    expect(wrapper.findAll("iframe")).toHaveLength(0)
    expect(loading(wrapper)).toBe(false)

    await alert.get("button").trigger("click")
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(submitted).toHaveLength(2)
    expect(preview).toHaveBeenCalledTimes(1)
  })

  it("puts back the field value, not the formatted text, when Escape ends an edit in the page", async () => {
    const { wrapper } = setup([Promise.resolve(tokenOf("one"))], "draft", ["title"])
    await flushPromises()
    const host = wrapper.findComponent(ConsoleDocumentPreview)
    const [frame] = frames(wrapper)
    const element = wrapper.get(`iframe[name="${frame!.name}"]`).element
    const page = new (Reflect.get(globalThis, "DOMParser") as new () => { parseFromString(html: string, type: string): unknown })()
      .parseFromString('<!doctype html><html><head></head><body><h1 data-content-field="posts:hello#title">Title: First</h1></body></html>', "text/html") as { querySelector(selector: string): { click(): void, dispatchEvent(event: unknown): boolean } | null, defaultView: unknown }
    const origin: string = Reflect.get(Reflect.get(globalThis, "location"), "origin")
    Object.defineProperty(page, "location", { configurable: true, value: { pathname: "/blog/hello", search: "" } })
    Object.defineProperty(element, "contentWindow", { configurable: true, value: { location: { href: `${origin}/blog/hello`, origin } } })
    Object.defineProperty(element, "contentDocument", { configurable: true, value: page })
    element.dispatchEvent(new Event("load"))
    await flushPromises()
    const heading = page.querySelector("h1")!
    heading.click()
    const KeyboardEvent = Reflect.get(globalThis, "KeyboardEvent") as new (type: string, init: object) => unknown
    heading.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await flushPromises()
    expect(host.emitted("edit")?.at(-1)).toEqual(["title", "First"])
  })
})
