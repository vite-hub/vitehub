import { readFile } from "node:fs/promises"
import { SourceTextModule } from "node:vm"
import { Browser } from "happy-dom"

const base = process.argv[2]
const sockets = []
let connected
let timeout
const connections = new Promise((resolve, reject) => {
  connected = resolve
  timeout = setTimeout(() => reject(new Error(`Expected two Realtime connections, got ${JSON.stringify(sockets)}`)), 2000)
})
const browser = new Browser({
  settings: {
    enableJavaScriptEvaluation: true,
    suppressInsecureJavaScriptEnvironmentWarning: true,
    fetch: {
      interceptor: {
        beforeAsyncRequest: async ({ request, window }) => {
          const path = new URL(request.url).pathname
          if (path === `${base}/api/_vitehub/comments/session`) {
            return window.Response.json({ data: {
              user: { id: "ada", name: "Ada" },
              can: { read: true, comment: true, resolve: true },
              realtime: true,
              content: false,
            } })
          }
          if (path === `${base}/api/_vitehub/comments/threads`) return window.Response.json({ data: [] })
          throw new Error(`Unexpected API request: ${request.url}`)
        },
      },
    },
  },
})
try {
  const page = browser.newPage()
  // The document URL deliberately differs from the overlay's base.
  page.url = "https://site.test/articles/example?vitehub"
  page.mainFrame.window.WebSocket = class {
    readyState = 0
    constructor(url) {
      sockets.push(url)
      if (sockets.length === 2) connected()
    }
    close() {}
  }
  const overlay = new SourceTextModule(await readFile(new URL("../../dist/overlay/overlay.js", import.meta.url), "utf8"), {
    context: page.mainFrame.window,
    initializeImportMeta(meta) { meta.url = `https://site.test${base}/api/_vitehub/comments/assets/overlay.js?v=2` },
  })
  await overlay.link(() => { throw new Error("The built overlay must be self-contained") })
  await overlay.evaluate()
  overlay.namespace.default({
    tool: { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: `${base}/api/_vitehub/comments/assets/overlay.js` },
    bar: page.mainFrame.document.createElement("div"),
    signal: new page.mainFrame.window.AbortController().signal,
    open: false,
    exit() { throw new Error("Unexpected tool exit") },
    createWindow() { throw new Error("Unexpected retained window") },
    openTool: async () => false,
    onOpen() {},
    beforeExit() {},
  })
  await connections
  console.log(JSON.stringify(sockets))
}
finally {
  clearTimeout(timeout)
  for (const page of browser.defaultContext.pages) page.mainFrame.document.querySelector("vitehub-comments")?.remove()
  await browser.close()
}
