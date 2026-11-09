// Mounts the real overlay the way the page tools loader does, with a Comments API that lets this visitor comment.
import start from "../../../src/overlay/index.ts"

const session = { user: { id: "u1", name: "Maxi" }, can: { read: true, comment: true, resolve: true, delete: true }, realtime: false, content: false }
const posted: unknown[] = []
Object.assign(window, { posted })
window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(String(input instanceof Request ? input.url : input), location.href)
  if (url.pathname.endsWith("/session")) return Response.json({ data: session })
  if ((init.method ?? "GET") !== "GET") posted.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
  return Response.json({ data: [] })
}

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
