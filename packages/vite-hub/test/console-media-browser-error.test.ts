// @vitest-environment happy-dom
import type { Window } from "happy-dom"
import { createApp, defineComponent, h } from "vue"
import { afterEach, expect, it, vi } from "vitest"

import ConsoleMediaBrowser from "../src/console/runtime/components/console-media-browser.vue"
import { createConsoleBlobMediaClient } from "../src/console/runtime/client/blob-media"
import { ConsoleRequestError } from "../src/console/runtime/client/request"

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

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); mocks.request.mockReset() })

it.each([
  { status: 401, buttons: ["Sign in again", "Read the docs"] },
  { status: 503, buttons: ["Try again", "Read the docs"] },
])("shows a $status load failure as the Console state", async ({ status, buttons }) => {
  mocks.request.mockRejectedValue(new ConsoleRequestError(status))
  const app = createApp(ConsoleMediaBrowser, { client: createConsoleBlobMediaClient("/blob", { readOnly: true, store: "default" }), mode: "page" })
  for (const name of ["UCheckbox", "UDropdownMenu", "UEmpty", "UIcon", "UInput", "UModal", "UPopover", "USelect", "USkeleton", "UTooltip"]) app.component(name, slot)
  app.component("UButton", button)
  // SAFETY: This test runs in happy-dom, whose window is the global scope.
  const { document } = globalThis as unknown as Pick<Window, "document">
  const container = document.createElement("div")
  document.body.append(container)
  cleanup = () => { app.unmount(); container.remove() }
  app.mount(container)
  await vi.waitFor(() => expect(container.querySelector("[role=alert]")?.textContent).toContain("Could not load files"))
  const alert = container.querySelector("[role=alert]")!
  expect([...alert.querySelectorAll("button")].map(element => element.textContent).slice(0, 2)).toEqual(buttons)
})
