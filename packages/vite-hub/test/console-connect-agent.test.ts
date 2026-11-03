// @vitest-environment happy-dom
import { Window } from "happy-dom"
import { createApp, defineComponent, h, nextTick, reactive } from "vue"
import { expect, it, vi } from "vitest"

import ConsoleConnectAgent from "../src/console/runtime/components/console-connect-agent.vue"
import type { ConsoleNavigation } from "../src/console/runtime/client/sections.ts"

it.each(["", "/portal", "/apps/_vitehub-preview", "/apps/_vitehub/preview"])("renders and copies mounted commands at %s, then updates the auth mode", async (mount) => {
  const window = new Window({ url: `https://app.example.com${mount}/_vitehub` })
  vi.stubGlobal("window", window)
  vi.stubGlobal("navigator", window.navigator)
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
    const commands = [...root.querySelectorAll("code")].map(element => element.textContent)
    for (const command of commands) expect(command).toContain(`https://app.example.com${mount}/_vitehub/mcp`)
    for (const [index, button] of [...root.querySelectorAll("button")].entries()) {
      button.click()
      await nextTick()
      expect(writeText).toHaveBeenLastCalledWith(commands[index])
    }
    props.auth = true
    await nextTick()
    expect(root.textContent).toContain("as the person who signs in")
    expect(root.textContent).not.toContain("CF_ACCESS_CLIENT_SECRET")
    expect(root.textContent).not.toContain("env_http_headers")
  }
  finally {
    app.unmount()
    vi.runAllTimers()
    vi.useRealTimers()
    writeText.mockRestore()
    vi.unstubAllGlobals()
  }
})
