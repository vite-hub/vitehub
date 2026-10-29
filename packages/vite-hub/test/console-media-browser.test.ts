// @vitest-environment happy-dom
import type { Window } from "happy-dom"
import { createApp, defineComponent, h } from "vue"
import { afterEach, expect, it, vi } from "vitest"

import ConsoleMediaBrowser from "../src/console/runtime/components/console-media-browser.vue"
import { consoleBlobMediaFile, createConsoleBlobMediaClient } from "../src/console/runtime/client/blob-media"
import { createConsoleMediaClient } from "../src/console/runtime/client/media-library"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(),
  requestConsole: mocks.request,
}))

const slot = defineComponent({ setup: (_props, { slots }) => () => h("div", slots.default?.()) })
const button = defineComponent({
  props: ["label"],
  setup: (props, { slots }) => () => h("button", props.label ?? slots.default?.()),
})
const menu = defineComponent({
  props: ["items"],
  setup: (props, { slots }) => () => h("div", [slots.default?.(), ...props.items.flat().map((item: { label: string }) => h("span", item.label))]),
})

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); mocks.request.mockReset() })

it.each([
  { content: false, readOnly: false },
  { content: false, readOnly: true },
  { content: true, readOnly: false },
])("shows supported actions for %j", async ({ content, readOnly }) => {
  const object = { pathname: "one.txt", uploadedAt: "2026-10-15T11:00:00Z", customMetadata: {}, httpMetadata: {}, size: 3 }
  const listing = { folders: ["images"], hasMore: false, store: "default" }
  mocks.request.mockResolvedValue(content
    ? { ...listing, access: { manage: true, read: true, write: true }, folder: "", items: [consoleBlobMediaFile(object)], served: null }
    : { ...listing, blobs: [object], stores: ["default"] })
  const client = content ? createConsoleMediaClient("/media", "content") : createConsoleBlobMediaClient("/blob", { readOnly, store: "default" })
  const app = createApp(ConsoleMediaBrowser, { client, mode: "page", selected: ["one.txt"] })
  for (const name of ["UAlert", "UCheckbox", "UEmpty", "UIcon", "UInput", "UModal", "UPopover", "USelect", "USkeleton", "UTooltip"]) app.component(name, slot)
  app.component("UButton", button)
  app.component("UDropdownMenu", menu)
  // SAFETY: This test runs in happy-dom, whose window is the global scope.
  const { document } = globalThis as unknown as Pick<Window, "document">
  const container = document.createElement("div")
  document.body.append(container)
  cleanup = () => { app.unmount(); container.remove() }
  app.mount(container)
  await vi.waitFor(() => expect(container.textContent).toContain("one.txt"))
  const text = container.textContent
  expect(Boolean(container.querySelector('[aria-label="New folder"]'))).toBe(content)
  expect(text?.includes("Rename or move")).toBe(content)
  expect(text?.includes("Move…")).toBe(content)
  expect(text?.includes("Delete folder")).toBe(content)
  expect(Boolean(container.querySelector('[aria-label="Actions for folder images"]'))).toBe(content)
  expect(text?.includes("Upload")).toBe(!readOnly)
  expect(text?.includes("Delete")).toBe(!readOnly)
})
