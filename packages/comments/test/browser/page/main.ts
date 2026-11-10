// Mounts the real overlay the way the page tools loader does. The test server answers the Comments API.
import start from "../../../src/overlay/index.ts"

document.querySelector(".menu-button")!.addEventListener("click", () => document.querySelector<HTMLDialogElement>("#menu")!.show())

const pill = document.createElement("vitehub-pill")
const bar = document.createElement("vitehub-tool")
bar.slot = "comments"
pill.append(bar)
document.documentElement.append(pill)
start({
  tool: { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "/overlay.js" },
  bar,
  signal: new AbortController().signal,
  open: false,
  exit() {},
  onOpen() {},
  beforeExit() {},
  openTool: async () => false,
  createWindow() {
    const body = document.createElement("div")
    document.body.append(body)
    return { body, show() {}, hide() {}, destroy() {} }
  },
} as unknown as Parameters<typeof start>[0])
