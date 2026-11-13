import { agentDiagnostics } from "./agent-diagnostics.ts"
import { pageHeader, pageRealtimeDefinition } from "./internal/page.ts"

declare const __VITEHUB_APP_BASE_URL__: string

/**
 * The ui-sdk bridge that `createAgent()` returns, from `@ui-sdk/vue/agent`, `@ui-sdk/core/agent`, or the bridge of another
 * framework. The page answers the Agent's `page_snapshot`, `page_query`, and `page_act` with these methods.
 */
export interface PageBridge {
  snapshot: () => unknown
  query: (input: { text?: string, within?: string, kind?: string }) => Promise<unknown>
  act: (input: { steps: Array<{ ref: string, action: string, args?: unknown[] }> }) => Promise<unknown>
}

/** The part of a Realtime room that the page uses, as `connectRealtimeRoom()` from `@vite-hub/realtime/client` returns it. */
export interface PageRoom {
  onRequest: (handler: (body: unknown) => unknown) => () => void
  onUpdate: (listener: () => void) => () => void
  status: () => "connected" | "connecting" | "disconnected"
  destroy: () => void
}

/** Joins one Realtime room, like `connectRealtimeRoom()` from `@vite-hub/realtime/client`. */
export type JoinPageRoom = (definition: string, room: string, options: { baseURL?: string }) => PageRoom

export interface ConnectedPage {
  /** This tab's page id. Empty during server rendering, where nothing connects. */
  readonly id: string
  /** The header that names this page on the request that starts an Agent: `{ "x-vitehub-page": id }`. */
  readonly headers: Readonly<Record<string, string>>
  /** Resolves when the page joined its Realtime room, or after 5 seconds, so a request sent after it finds the page. */
  readonly ready: Promise<void>
  /** Leaves the room. The Agent's next page call returns `REALTIME_ROOM_EMPTY`. */
  close: () => void
}

export interface ConnectPageOptions {
  /** The app base path for a prebuilt client, such as `/portal/`. Defaults to the app's build-time base. */
  baseURL?: string
  /**
   * Joins the page's Realtime room: `connectRealtimeRoom` from `vite-hub/realtime/client`. The Agent package does not
   * load Realtime itself, so the page passes it.
   */
  join: JoinPageRoom
}

const methods = new Set(["act", "query", "snapshot"])

function appBaseURL(): string | undefined {
  return typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? undefined : __VITEHUB_APP_BASE_URL__
}

/**
 * Lets a ViteHub Agent work this page through a ui-sdk bridge. The page joins its own Realtime room with `join`, named
 * by a random page id, and answers the Agent's `page_snapshot`, `page_query`, and `page_act` with the bridge. Pass the
 * result to `useChat(agent, { page })`, or send `headers` with the request that starts the Agent, so its `page()`
 * Capability finds this page. Every change the Agent makes reaches the components with `source: "agent"`, and the
 * bridge's own `allow` decides each step. During server rendering it does nothing.
 *
 * @example
 * const page = connectPage(createAgent(), { join: connectRealtimeRoom })
 * const chat = useChat(useAgent("settings"), { page })
 */
export function connectPage(bridge: PageBridge, options: ConnectPageOptions): ConnectedPage {
  if (!("window" in globalThis)) return { id: "", headers: {}, ready: Promise.resolve(), close: () => {} }
  if (typeof options?.join !== "function") throw agentDiagnostics.AGENT_R1046()
  // A new id for each page load: a duplicated tab copies sessionStorage, and two tabs must never share one room.
  const id = crypto.randomUUID()
  const baseURL = options.baseURL ?? appBaseURL()
  const room = options.join(pageRealtimeDefinition, id, baseURL ? { baseURL } : {})
  room.onRequest(body => answer(bridge, body))
  const ready = room.status() === "connected"
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        // The server waits a few seconds for a page to join, so a slow connection does not hold the request.
        const timer = setTimeout(done, 5_000)
        const stop = room.onUpdate(() => {
          if (room.status() === "connected") done()
        })
        function done() {
          clearTimeout(timer)
          stop()
          resolve()
        }
      })
  return {
    id,
    headers: Object.freeze({ [pageHeader]: id }),
    ready,
    close: () => room.destroy(),
  }
}

/** Runs one Agent call with the bridge. The input is the model's, so its shape is checked here. */
async function answer(bridge: PageBridge, body: unknown): Promise<unknown> {
  if (!body || typeof body !== "object" || !("method" in body) || typeof body.method !== "string" || !methods.has(body.method)) {
    throw new Error("Unknown page call.")
  }
  const input: unknown = "input" in body && body.input && typeof body.input === "object" ? body.input : {}
  if (body.method === "snapshot") return bridge.snapshot()
  // SAFETY: ui-sdk checks each query field itself, and answers a bad one with `ok: false`.
  if (body.method === "query") return await bridge.query(input as Parameters<PageBridge["query"]>[0])
  // SAFETY: ui-sdk checks every step of `act`, as above.
  return await bridge.act(input as Parameters<PageBridge["act"]>[0])
}
