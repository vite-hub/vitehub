import { viteHubPageToolsWanted } from "@vite-hub/internal/runtime/page-tools-shared"

import { commentsAnswerError, commentsUnansweredError } from "../client-diagnostics.ts"
import { embedChangedEvent, embedChannelName, embedCodeParam, embedConnectType, embedPath } from "./protocol.ts"

import type { EmbedAnswer, EmbedFrame, EmbedRelay } from "./protocol.ts"

const frameTimeout = 15_000
const requestTimeout = 30_000
const relayWait = 5_000

const codeFragmentOrHashRoute = new RegExp(`^#(/?)${embedCodeParam}=([\\w-]+)$`)

function takeCode(): string | undefined {
  const match = codeFragmentOrHashRoute.exec(location.hash)
  if (!match) return undefined
  const [, hashRouteSlash, code] = match
  history.replaceState(history.state, "", `${location.pathname}${location.search}${hashRouteSlash ? "#/" : ""}`)
  return code
}

function remembered(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === "1"
  }
  catch {
    return false
  }
}

function remember(key: string): void {
  try {
    sessionStorage.setItem(key, "1")
  }
  catch {}
}

function connect(consoleOrigin: string, projectId: string): Promise<EmbedFrame> {
  const iframe = document.createElement("iframe")
  iframe.src = `${consoleOrigin}${embedPath(projectId)}`
  iframe.hidden = true
  iframe.tabIndex = -1
  iframe.title = "ViteHub Comments"
  iframe.setAttribute("aria-hidden", "true")
  iframe.setAttribute("data-comments-ui", "")
  const channel = new MessageChannel()
  const pending = new Map<number, (answer: EmbedAnswer) => void>()
  const changeListeners = new Set<() => void>()
  let next = 0
  const frame: EmbedFrame = {
    call: (method, input) => new Promise((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(commentsUnansweredError(0))
      }, requestTimeout)
      pending.set(id, (answer) => {
        clearTimeout(timer)
        if (answer.ok) resolve(answer)
        else reject(commentsAnswerError(answer.error))
      })
      channel.port1.postMessage({ id, method, input })
    }),
    onChange(listener) {
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    },
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(commentsUnansweredError(0)), frameTimeout)
    channel.port1.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
      if (data === null || typeof data !== "object") return
      const event: unknown = Reflect.get(data, "event")
      if (event === "ready") {
        clearTimeout(timer)
        resolve(frame)
      }
      else if (event === embedChangedEvent) {
        for (const listener of changeListeners) listener()
      }
      else {
        const id: unknown = Reflect.get(data, "id")
        const settle = typeof id === "number" ? pending.get(id) : undefined
        if (!settle || typeof id !== "number") return
        pending.delete(id)
        // SAFETY: only the frame holds the other end of this port, and it answers each request with an `EmbedAnswer`.
        settle(data as EmbedAnswer)
      }
    })
    channel.port1.start()
    iframe.addEventListener("load", () => iframe.contentWindow?.postMessage({ type: embedConnectType }, consoleOrigin, [channel.port2]), { once: true })
    iframe.addEventListener("error", () => reject(commentsUnansweredError(0)), { once: true })
    document.documentElement.append(iframe)
  })
}

async function relayed(channel: BroadcastChannel, code: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => done(false), relayWait)
    function done(value: boolean) {
      clearTimeout(timer)
      channel.removeEventListener("message", listen)
      resolve(value)
    }
    function listen({ data }: MessageEvent<EmbedRelay>) {
      if (data.type === "redeemed" && data.code === code) done(true)
    }
    channel.addEventListener("message", listen)
    channel.postMessage({ type: "code", code } satisfies EmbedRelay)
  })
}

async function start(projectId: string, consoleOrigin: string): Promise<void> {
  const code = takeCode()
  const hint = `vitehub-comments:${projectId}`
  if (!code && !remembered(hint) && !viteHubPageToolsWanted(location.search, document.cookie)) return
  remember(hint)
  const channel = new BroadcastChannel(embedChannelName(projectId))
  const frame = connect(consoleOrigin, projectId)
  const redeem = async (value: string) => (await (await frame).call("redeem", value)).value === true
  const tools = import("./tools.ts")
  channel.addEventListener("message", ({ data }: MessageEvent<EmbedRelay>) => {
    if (data.type !== "code") return
    void redeem(data.code).then((done) => {
      if (done) {
        channel.postMessage({ type: "redeemed", code: data.code } satisfies EmbedRelay)
        void tools.then(({ mountHostedComments }) => mountHostedComments(frame, { id: projectId, console: consoleOrigin }))
      }
    }, () => undefined)
  })
  const redeemed = code ? await redeem(code).catch(() => false) : false
  if (code && !redeemed && await relayed(channel, code)) {
    window.close()
    return
  }
  const { mountHostedComments } = await tools
  await mountHostedComments(frame, { id: projectId, console: consoleOrigin })
}

const script = document.querySelector<HTMLScriptElement>("script[data-vitehub-comments]")
const projectId = script?.dataset.vitehubComments
if (projectId) void start(projectId, new URL(import.meta.url).origin)
