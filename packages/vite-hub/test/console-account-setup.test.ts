// @vitest-environment happy-dom
import { Window } from "happy-dom"
import { createApp, defineComponent, h, nextTick, shallowRef } from "vue"
import { describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ roles: [] as string[] }))
vi.mock("../src/console/runtime/client/project-session", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/project-session")>(),
  useConsoleProjects: () => ({ account: shallowRef({ roles: state.roles }) }),
}))
vi.mock("../src/console/runtime/components/console-hosted-comments-embed.vue", () => ({ default: defineComponent({ render: () => null }) }))
vi.mock("../src/console/runtime/components/console-account-unlink.vue", () => ({
  default: defineComponent({ props: { name: String }, setup: props => () => h("div", { "data-dialog": `Unlink ${props.name}?` }) }),
}))

import ConsoleAccountSetup from "../src/console/runtime/components/console-account-setup.vue"

const slot = defineComponent({ setup: (_props, { slots }) => () => h("div", slots.default?.()) })
const stubs = {
  UButton: defineComponent({ props: { label: String }, setup: props => () => h("button", { "data-button": props.label }, props.label) }),
  CodeBlock: slot,
  CodeBlockActions: slot,
  CodeBlockContent: slot,
  CodeBlockCopyButton: slot,
  CodeBlockHeader: slot,
  CodeBlockTitle: slot,
}

async function render(roles: string[], publicKey: string | null) {
  state.roles = roles
  const root = new Window().document.createElement("div")
  const app = createApp(ConsoleAccountSetup, { project: { id: "p-1", url: "https://docs.example.com", label: null, publicKey, keyVariable: publicKey && "VITEHUB_CONSOLE_KEY_CONSOLE_P1" } })
  for (const [name, stub] of Object.entries(stubs)) app.component(name, stub)
  app.config.warnHandler = () => {}
  app.mount(root)
  await nextTick()
  const seen = {
    buttons: [...root.querySelectorAll("[data-button]")].map(button => button.getAttribute("data-button")),
    dialogs: [...root.querySelectorAll("[data-dialog]")].map(dialog => dialog.getAttribute("data-dialog")),
  }
  app.unmount()
  return seen
}

describe("Console app setup", () => {
  it.each([["key", "pk"], ["hosted Comments", null]])("shows Unlink to owners and admins only, on the %s setup", async (_kind, publicKey) => {
    for (const roles of [["owner"], ["admin"]]) {
      const { buttons, dialogs } = await render(roles, publicKey)
      expect(buttons).toContain("Unlink docs.example.com")
      expect(dialogs).toEqual(["Unlink docs.example.com?"])
    }
    const member = await render(["member"], publicKey)
    expect(member.buttons).not.toContain("Unlink docs.example.com")
    expect(member.dialogs).toEqual([])
  })
})
