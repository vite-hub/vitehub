// @vitest-environment happy-dom
import { Window } from "happy-dom"
import type { HTMLElement } from "happy-dom"
import { createApp, defineComponent, h, nextTick, reactive } from "vue"
import type { PropType } from "vue"
import { expect, it, vi } from "vitest"

import ConsoleConnectAgent from "../src/console/runtime/components/console-connect-agent.vue"
import { consoleProject, setConsoleProject } from "../src/console/runtime/client/project.ts"
import type { ConsoleNavigation } from "../src/console/runtime/client/sections.ts"

const pageProject = consoleProject()

// UTabs as the Console uses it: one tab per item, and the content slot of the selected item.
const UTabs = defineComponent({
  props: { items: { type: Array as PropType<Array<{ label: string, value: string }>>, required: true }, modelValue: { type: String, default: undefined } },
  emits: ["update:modelValue"],
  setup(props, { emit, slots }) {
    return () => h("div", [
      h("div", { role: "tablist" }, props.items.map(item => h("button", {
        role: "tab",
        "aria-selected": String(item.value === props.modelValue),
        onClick: () => emit("update:modelValue", item.value),
      }, item.label))),
      ...props.items.filter(item => item.value === props.modelValue).map(item => h("div", { role: "tabpanel" }, slots.content?.({ item }))),
    ])
  },
})

it.each(["", "/portal", "/apps/_vitehub-preview", "/apps/_vitehub/preview"])("renders and copies mounted commands at %s, then updates the auth mode", async (mount) => {
  const window = new Window({ url: `https://app.example.com${mount}/_vitehub` })
  vi.stubGlobal("window", window)
  vi.stubGlobal("navigator", window.navigator)
  setConsoleProject({ origin: "", base: mount })
  const writeText = vi.spyOn(window.navigator.clipboard, "writeText").mockResolvedValue()
  const props = reactive<{ auth: ConsoleNavigation["auth"] }>({ auth: "cloudflare-access" })
  const app = createApp({ render: () => h(ConsoleConnectAgent, props) })
  app.component("UButton", defineComponent({ setup: (_, { attrs }) => () => h("button", attrs) }))
  app.component("UTabs", UTabs)
  const root = window.document.createElement("div")
  app.mount(root)
  vi.useFakeTimers()
  try {
    expect(root.textContent).toContain("Service Auth policy")
    expect(root.textContent).toContain("CF_ACCESS_CLIENT_SECRET")
    expect(root.textContent).not.toContain("as the person who signs in")
    const url = `https://app.example.com${mount}/_vitehub/mcp`
    root.querySelector<HTMLElement>('[aria-label="Copy the server URL"]')!.click()
    await nextTick()
    expect(writeText).toHaveBeenLastCalledWith(url)
    // Each client has a tab; its panel shows and copies its own command.
    const tabs = [...root.querySelectorAll<HTMLElement>("[role=tab]")]
    expect(tabs.map(tab => tab.textContent?.trim())).toEqual(["Claude Code", "Codex"])
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true")
    const commands: string[] = []
    for (const tab of tabs) {
      tab.click()
      await nextTick()
      expect(root.querySelector(`[role=tab][aria-selected="true"]`)?.textContent).toBe(tab.textContent)
      const panels = [...root.querySelectorAll<HTMLElement>("[role=tabpanel]")]
      expect(panels).toHaveLength(1)
      const command = panels[0]!.querySelector("pre code")!.textContent!
      expect(command).toContain(url)
      commands.push(command)
      panels[0]!.querySelector<HTMLElement>("button")!.click()
      await nextTick()
      expect(writeText).toHaveBeenLastCalledWith(command)
    }
    expect(new Set(commands).size).toBe(2)
    props.auth = true
    await nextTick()
    expect(root.textContent).toContain("as the person who signs in")
    expect(root.textContent).not.toContain("CF_ACCESS_CLIENT_SECRET")
    expect(root.textContent).not.toContain("env_http_headers")
    expect([...root.querySelectorAll("[role=tab]")].map(tab => tab.textContent?.trim())).toEqual(["Claude Code", "Codex", "Cursor", "VS Code"])
  }
  finally {
    app.unmount()
    vi.runAllTimers()
    vi.useRealTimers()
    writeText.mockRestore()
    setConsoleProject(pageProject)
    vi.unstubAllGlobals()
  }
})
