/**
 * A script that ViteHub adds to the app's HTML pages, such as the Comments overlay. An owner package registers it with
 * `registerViteHubPageTool(nitroApp, tool)` when the server starts, then calls `installViteHubPageTools(nitroApp)`.
 */
export interface ViteHubPageTool {
  /** The owner, such as `comments`. The script tag has it in `data-vitehub-page-tool`. */
  id: string
  /** The URL of the module script that the page loads. */
  script: string
  /**
   * Whether this request gets the script. Read only the path, the query, and the headers, such as a hint cookie. It is a
   * hint, never a credential: the tool's API must still check access. Paths under `/_vitehub` and `/api/` never get a
   * page tool, so this function does not see them.
   */
  wants(request: Request): boolean
}

interface PageToolsState {
  tools: WeakMap<object, Map<string, ViteHubPageTool>>
  installed: WeakSet<object>
}

const stateKey: unique symbol = Symbol.for("vitehub.page-tools")
// SAFETY: This module owns the process slot. Owner packages bundle their own copy of it, so the registry and the
// installed Nitro apps must be shared through the slot, not through module state.
const scope = globalThis as typeof globalThis & { [stateKey]?: PageToolsState }

function state(): PageToolsState {
  return scope[stateKey] ??= { installed: new WeakSet(), tools: new WeakMap() }
}

/** Registers a page tool for one Nitro app, before or after installation. The same id replaces only that app's tool. */
export function registerViteHubPageTool(nitroApp: unknown, tool: ViteHubPageTool): void {
  if (nitroApp === null || typeof nitroApp !== "object") return
  const { tools } = state()
  let registry = tools.get(nitroApp)
  if (!registry) {
    registry = new Map()
    tools.set(nitroApp, registry)
  }
  registry.set(tool.id, tool)
}

/** The app's registered tools that want this request, in registration order. */
function wantedTools(nitroApp: object, request: Request): ViteHubPageTool[] {
  const { pathname } = new URL(request.url)
  if (pathname.startsWith("/_vitehub") || pathname.startsWith("/api/")) return []
  return [...state().tools.get(nitroApp)?.values() ?? []].filter(tool => tool.wants(request))
}

function scriptTag(tool: ViteHubPageTool, nonce?: string): string {
  const id = tool.id.replace(/"/g, "&quot;")
  return `<script type="module" src="${tool.script.replace(/"/g, "&quot;")}"${nonce ? ` nonce="${nonce}"` : ""} data-vitehub-page-tool="${id}"></script>`
}

function scriptTags(tools: readonly ViteHubPageTool[], nonce?: string): string {
  return tools.map(tool => scriptTag(tool, nonce)).join("")
}

/**
 * The script nonce of a page's Content Security Policy. A policy with `'strict-dynamic'`, such as the one of
 * nuxt-security, blocks a script without it, even from the same origin.
 */
export function scriptNonce(headers: Headers): string | undefined {
  const directives = (headers.get("content-security-policy") ?? "").split(";").map(part => part.trim())
  // Browsers read `script-src-elem`, else `script-src`, else `default-src` for a script element.
  const directive = ["script-src-elem", "script-src", "default-src"]
    .map(name => directives.find(part => part.toLowerCase().startsWith(`${name} `)))
    .find(Boolean)
  return directive ? /'nonce-([\w+/=-]+)'/.exec(directive)?.[1] : undefined
}

/**
 * Inserts the script tags of `tools` before `</body>` of a streamed HTML body, or at its end when it has none. The
 * page then varies per person, so it drops `content-length` and sends `cache-control: private, no-store`. Other
 * responses, and a call without tools, return the response unchanged. `policyHeaders` supplies the effective CSP
 * when the host keeps it separately from the returned Response.
 */
export function injectPageScripts(response: Response, tools: readonly ViteHubPageTool[], policyHeaders: Headers = response.headers): Response {
  const type = response.headers.get("content-type") ?? ""
  if (tools.length === 0 || !response.body || response.status !== 200 || !type.includes("text/html")) return response
  const tags = scriptTags(tools, scriptNonce(policyHeaders))
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let tail = ""
  let done = false
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (done) {
        controller.enqueue(chunk)
        return
      }
      const text = tail + decoder.decode(chunk, { stream: true })
      const index = text.search(/<\/body\s*>/i)
      if (index !== -1) {
        done = true
        controller.enqueue(encoder.encode(text.slice(0, index) + tags + text.slice(index)))
        tail = ""
        return
      }
      // Keep the end, so a `</body>` split across chunks is still found.
      const keep = Math.max(0, text.length - 8)
      controller.enqueue(encoder.encode(text.slice(0, keep)))
      tail = text.slice(keep)
    },
    flush(controller) {
      const rest = tail + decoder.decode()
      controller.enqueue(encoder.encode(done ? rest : rest + tags))
    },
  })
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.set("cache-control", "private, no-store")
  return new Response(response.body.pipeThrough(transform), { headers, status: response.status, statusText: response.statusText })
}

/** The parts of an H3 1 event that the Nitro 2 hooks read. */
interface Nitro2Event {
  web?: { request?: Request }
  node?: {
    req?: { url?: string, originalUrl?: string, headers?: Record<string, string> }
    res?: { setHeader?: (name: string, value: string) => void, getHeader?: (name: string) => unknown }
  }
}

/** The Web request of an H3 1 event. Only the path, query, and headers matter to a page tool. */
function nitro2Request(event: Nitro2Event): Request | undefined {
  const node = event.node?.req
  // H3 strips the application base from `url` and keeps the public path in `originalUrl`.
  const path = node?.originalUrl || node?.url
  return event.web?.request ?? (path ? new Request(new URL(path, "http://localhost"), { headers: node?.headers }) : undefined)
}

/**
 * Adds the registered page tools to the HTML pages of a Nitro app. Call it from each owner's Nitro plugin: it installs
 * once per app, whatever the number of calls. It reads that app's registry on each request, so plugin order does not matter.
 * - Nitro 3: it wraps `nitroApp.fetch`, the Web entry that every preset calls.
 * - Nitro 2 with Nuxt: it hooks `render:html` for rendered pages, and `beforeResponse` for pages that a route returns
 *   as a `Response`, such as a prerendered file that a Cloudflare Worker reads from its assets.
 */
export function installViteHubPageTools(nitroApp: unknown): void {
  if (nitroApp === null || typeof nitroApp !== "object") return
  const { installed } = state()
  if (installed.has(nitroApp)) return
  installed.add(nitroApp)

  const fetch: unknown = Reflect.get(nitroApp, "fetch")
  if (fetch instanceof Function) {
    Reflect.set(nitroApp, "fetch", async (request: Request, ...rest: unknown[]) => {
      const response: unknown = await Reflect.apply(fetch, nitroApp, [request, ...rest])
      return response instanceof Response && request instanceof Request ? injectPageScripts(response, wantedTools(nitroApp, request)) : response
    })
    return
  }
  const hooks: unknown = Reflect.get(nitroApp, "hooks")
  const hook: unknown = hooks !== null && typeof hooks === "object" ? Reflect.get(hooks, "hook") : undefined
  if (!(hook instanceof Function)) return
  Reflect.apply(hook, hooks, ["render:html", (html: { bodyAppend: string[] }, context: { event: Nitro2Event }) => {
    const request = nitro2Request(context.event)
    const tools = request ? wantedTools(nitroApp, request) : []
    if (tools.length === 0) return
    const res = context.event.node?.res
    const policy = res?.getHeader?.("content-security-policy")
    html.bodyAppend.push(scriptTags(tools, typeof policy === "string" ? scriptNonce(new Headers({ "content-security-policy": policy })) : undefined))
    // As on the fetch path: a page with a page tool must never reach a shared cache.
    res?.setHeader?.("cache-control", "private, no-store")
  }])
  Reflect.apply(hook, hooks, ["beforeResponse", (event: Nitro2Event, response: { body?: unknown }) => {
    if (!(response.body instanceof Response)) return
    const request = nitro2Request(event)
    if (request) {
      // H3 preserves Node response headers unless the returned Response replaces them.
      const headers = new Headers(response.body.headers)
      const policy = event.node?.res?.getHeader?.("content-security-policy")
      if (!headers.has("content-security-policy") && typeof policy === "string") headers.set("content-security-policy", policy)
      response.body = injectPageScripts(response.body, wantedTools(nitroApp, request), headers)
    }
  }])
}
