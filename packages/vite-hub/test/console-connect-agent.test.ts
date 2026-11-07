// @vitest-environment happy-dom
import { Window } from "happy-dom"
import type { HTMLElement } from "happy-dom"
import { createApp, defineComponent, h, nextTick, reactive } from "vue"
import { expect, it, vi } from "vitest"

import ConsoleConnectAgent from "../src/console/runtime/components/console-connect-agent.vue"
import { consoleProject, setConsoleProject } from "../src/console/runtime/client/project.ts"
import type { ConsoleNavigation } from "../src/console/runtime/client/sections.ts"

const pageProject = consoleProject()

it.each(["", "/portal", "/apps/_vitehub-preview", "/apps/_vitehub/preview"])("renders and copies mounted commands at %s, then updates the auth mode", async (mount) => {
  const window = new Window({ url: `https://app.example.com${mount}/_vitehub` })
  vi.stubGlobal("window", window)
  vi.stubGlobal("navigator", window.navigator)
  setConsoleProject({ origin: "", base: mount })
  const writeText = vi.spyOn(window.navigator.clipboard, "writeText").mockResolvedValue()
  const props = reactive<{ auth: ConsoleNavigation["auth"] }>({ auth: "cloudflare-access" })
  const app = createApp({ render: () => h(ConsoleConnectAgent, props) })
  app.component("UButton", defineComponent({ setup: (_, { attrs }) => () => h("button", attrs) }))
  const root = window.document.createElement("div")
  app.mount(root)
  vi.useFakeTimers()
  try {
    expect(root.textContent).toContain("Service Auth policy")
    expect(root.textContent).toContain("CF_ACCESS_CLIENT_SECRET")
    expect(root.textContent).not.toContain("as the person who signs in")
    const url = `https://app.example.com${mount}/_vitehub/mcp`
    const commands = [...root.querySelectorAll("pre code")].map(element => element.textContent)
    expect(commands).toHaveLength(2)
    for (const command of commands) expect(command).toContain(url)
    root.querySelector<HTMLElement>('[aria-label="Copy the server URL"]')!.click()
    await nextTick()
    expect(writeText).toHaveBeenLastCalledWith(url)
    // Each client has a tab; its panel copies its own command.
    const tabs = [...root.querySelectorAll<HTMLElement>("[role=tab]")]
    expect(tabs.map(tab => tab.textContent?.trim())).toEqual(["Claude Code", "Codex"])
    for (const [index, tab] of tabs.entries()) {
      tab.click()
      await nextTick()
      expect(tab.getAttribute("aria-selected")).toBe("true")
      const panel = root.querySelector<HTMLElement>(`#${tab.getAttribute("aria-controls")}`)!
      expect(panel.hidden).toBe(false)
      panel.querySelector<HTMLElement>("button")!.click()
      await nextTick()
      expect(writeText).toHaveBeenLastCalledWith(commands[index])
    }
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
