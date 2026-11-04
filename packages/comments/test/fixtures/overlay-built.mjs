import { readFile } from "node:fs/promises"
import { SourceTextModule } from "node:vm"
import { Browser } from "happy-dom"

const base = process.argv[2]
const sockets = []
let connected
let timeout
const connections = new Promise((resolve, reject) => {
  connected = resolve
  timeout = setTimeout(() => reject(new Error(`Expected a page presence connection, got ${JSON.stringify(sockets)}`)), 2000)
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
            if (new URL(request.url).searchParams.get("page") !== "/articles/example") throw new Error("The session must authorize the current page")
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
      if (sockets.length === 1) connected()
    }
    close() {}
  }
  // The overlay and its chunks load from the asset directory only. Presence loads the Realtime chunk with `import()`.
  const assets = `https://site.test${base}/api/_vitehub/comments/assets/`
  const modules = new Map()
  const moduleOf = (url) => {
    const name = new URL(url).pathname.slice(new URL(assets).pathname.length)
    if (!modules.has(name)) {
      modules.set(name, readFile(new URL(`../../dist/overlay/${name}`, import.meta.url), "utf8").then(source => new SourceTextModule(source, {
        context: page.mainFrame.window,
        identifier: url,
        initializeImportMeta(meta) { meta.url = name === "overlay.js" ? `${assets}overlay.js?v=2` : url },
        importModuleDynamically: async (specifier, referrer) => await ready((await link(specifier, referrer)).identifier),
      })))
    }
    return modules.get(name)
  }
  const link = async (specifier, referrer) => {
    const url = new URL(specifier, referrer.identifier).href
    if (!url.startsWith(assets)) throw new Error(`The built overlay must be self-contained, but imports ${specifier}`)
    return await moduleOf(url)
  }
  const ready = async (url) => {
    const module = await moduleOf(url)
    if (module.status === "unlinked") await module.link(link)
    if (module.status === "linked") await module.evaluate()
    return module
  }
  const overlay = await ready(`${assets}overlay.js`)
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
