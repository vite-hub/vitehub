import { mountViteHubPagePill, viteHubPageSvgIcon } from "../../../../internal/src/runtime/page-pill.ts"
import start from "../../../src/overlay/index.ts"

const controller = new AbortController()
const pill = mountViteHubPagePill({
  name: "vitehub-pill",
  label: "ViteHub tools",
  mark: viteHubPageSvgIcon("0 0 20 18", "M19.734 8.156 15.576.844A1.66 1.66 0 0 0 14.135 0H5.819C5.226 0 4.677.32 4.38.844L.222 8.156a1.71 1.71 0 0 0 0 1.688l4.158 7.312c.297.523.846.844 1.439.844h8.316c.593 0 1.142-.32 1.438-.844l4.158-7.312c.3-.523.3-1.165.003-1.688Z", { fill: "currentColor" }),
  slots: ["comments"],
  storage: { collapsed: "send-test-collapsed", dock: "send-test-dock" },
  exit: { label: "Turn off ViteHub tools", press: () => {} },
  signal: controller.signal,
})
const bar = document.createElement("vitehub-tool")
bar.slot = "comments"
pill.append(bar)
start({
  tool: { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "/overlay.js" },
  bar,
  signal: controller.signal,
  open: false,
  exit() {},
  onOpen() {},
  beforeExit() {},
  openTool: async () => false,
  createWindow() {
    const body = document.createElement("div")
    document.body.append(body)
    return { body, show() {}, hide() {}, destroy() {}, syncColorScheme() {} }
  },
} as unknown as Parameters<typeof start>[0])
