import * as time from "lib0/time"

import type { WebsocketProvider } from "y-websocket"

import { realtimeKeepalivePing, realtimeKeepalivePong } from "./protocol.ts"

const keepaliveIntervalMs = 15_000

/**
 * y-websocket closes a socket that received nothing for 30 seconds, then connects again. A room with nobody else in it,
 * and the workspace events room, can stay silent for much longer. So the provider pings every 15 seconds while it is
 * connected, and the pong counts as a received message.
 */
export function keepRealtimeSocketAlive(provider: WebsocketProvider): void {
  let timer: ReturnType<typeof setInterval> | undefined
  provider.on("status", ({ status }: { status: string }) => {
    clearInterval(timer)
    timer = undefined
    const socket = provider.ws
    if (status !== "connected" || !socket) return
    const receive = socket.onmessage
    socket.onmessage = function (event: MessageEvent) {
      if (event.data !== realtimeKeepalivePong) return receive?.call(this, event)
      if (provider.ws === socket) provider.wsLastMessageReceived = time.getUnixTime()
    }
    timer = setInterval(() => {
      if (provider.ws === socket && socket.readyState === socket.OPEN) socket.send(realtimeKeepalivePing)
    }, keepaliveIntervalMs)
  })
}
