// Mounts the real overlay the way the page tools loader does. The test server answers the Comments API.
import start from "../../../src/overlay/index.ts"

document.querySelector(".menu-button")!.addEventListener("click", () => document.querySelector<HTMLDialogElement>("#menu")!.show())

const pill = document.createElement("vitehub-pill")
// Where the loader docks it, over the page and the comment UI, with the type of the real pill (`viteHubPagePillStyles`).
pill.style.cssText = "position:fixed;left:50%;bottom:16px;translate:-50% 0;z-index:2147483001;display:flex;background:#111;border-radius:12px;padding:4px;font:500 12px/1 ui-sans-serif,system-ui,sans-serif;color:#d4d4d4;-webkit-font-smoothing:antialiased"
const bar = document.createElement("vitehub-tool")
bar.slot = "comments"
// The real pill lays out each segment it holds with `::slotted(*)`: a row, centered.
bar.style.cssText = "display:flex;align-items:center;gap:2px"
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
