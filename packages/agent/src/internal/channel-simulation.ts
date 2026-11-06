import type { Adapter, ChatInstance } from "chat"

/** The Server Env variable that turns on Channel simulation. `vitehub({ agent: { channels: { simulate: true } } })` sets it in `vite dev`. */
export const channelSimulationEnv = "VITEHUB_CHANNELS"

/** The one user of a simulated Channel. A simulated Channel is a direct message between this user and the Agent. */
export const simulatedChatUserId = "learner"

const simulatedKinds: ReadonlySet<string> = new Set(["discord", "slack", "teams", "telegram"])
const simulatedAdapters = new WeakSet<object>()

/** Whether the adapter is a simulated chat adapter, which has no provider connection such as a Discord Gateway. */
export function isSimulatedChatAdapter(adapter: object): boolean {
  return simulatedAdapters.has(adapter)
}

/**
 * Whether a Channel of this kind runs on the simulated chat. Only the built-in chat Channels are simulated, and never
 * when `NODE_ENV` is `production`, so a deployed app always talks to the real provider.
 */
export function isChannelSimulated(kind: string): boolean {
  const env = globalThis.process?.env
  return simulatedKinds.has(kind) && env?.[channelSimulationEnv] === "simulate" && env.NODE_ENV !== "production"
}

/**
 * The Chat SDK web adapter that a simulated Channel uses. It speaks the AI SDK UI message stream on the Channel's own
 * webhook route, so any AI SDK chat client can talk to the Agent as that Channel.
 *
 * `@chat-adapter/web` names itself `web` and prefixes its thread ids with `web:`. Two simulated Channels would then
 * share one adapter name, so each one gets the Channel kind as its name and thread prefix.
 */
export async function createSimulatedChatAdapter(kind: string): Promise<Adapter> {
  const [{ createWebAdapter }, { AsyncLocalStorage }] = await Promise.all([import("@chat-adapter/web"), import("node:async_hooks")])
  const prefix = `${kind}:`
  const adapter = createWebAdapter({
    userName: "agent",
    getUser: () => ({ id: simulatedChatUserId }),
    threadIdFor: ({ user, conversationId }) => `${prefix}${user.id}:${conversationId}`,
  })
  const decode = adapter.decodeThreadId.bind(adapter)
  const encode = adapter.encodeThreadId.bind(adapter)
  Object.defineProperty(adapter, "name", { value: kind })
  adapter.decodeThreadId = threadId => decode(threadId.startsWith(prefix) ? `web:${threadId.slice(prefix.length)}` : threadId)
  adapter.encodeThreadId = data => `${prefix}${encode(data).slice("web:".length)}`

  // The web adapter keeps the request of a reply in an AsyncLocalStorage. A StackBlitz WebContainer loses that store
  // after the first `await`, so `postMessage()` and `stream()` would not find the request. Take a snapshot of the
  // request context when the adapter gives the message to Chat, and enter it again for each reply in that thread.
  const requests = new Map<string, <T>(run: () => T) => T>()
  const inRequest = <T>(threadId: string, run: () => T): T => {
    const enter = requests.get(threadId)
    return enter ? enter(run) : run()
  }
  const initialize = adapter.initialize.bind(adapter)
  adapter.initialize = chat => initialize(new Proxy(chat, {
    get: (target, key) => key !== "processMessage" ? Reflect.get(target, key) : (...args: Parameters<ChatInstance["processMessage"]>) => {
      const threadId = args[1]
      const enter = AsyncLocalStorage.snapshot()
      requests.set(threadId, enter)
      return target.processMessage(...args).finally(() => {
        if (requests.get(threadId) === enter) requests.delete(threadId)
      })
    },
  }))
  const postMessage = adapter.postMessage.bind(adapter)
  const stream = adapter.stream.bind(adapter)
  adapter.postMessage = (threadId, message) => inRequest(threadId, () => postMessage(threadId, message))
  adapter.stream = (threadId, iterable, options) => inRequest(threadId, () => stream(threadId, iterable, options))
  simulatedAdapters.add(adapter)
  return adapter
}
