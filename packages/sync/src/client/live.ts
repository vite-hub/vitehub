// Reads a Server-Sent Events body by hand, so the client needs no `EventSource`: that one cannot send the `fetch`
// option of the store, and it reconnects on its own schedule. Only the `event` and `data` fields matter to Sync.

/** One event of the stream. `type` is `message` when the server sent no `event` field. */
interface SyncStreamEvent {
  type: string
  data: string
}

/** The events of `body`, in order. Comment lines, such as `: ping`, are skipped. Ends when the body ends. */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SyncStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let type = ""
  let data: string[] = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const end = buffer.search(/[\r\n]/)
        // A `\r` at the end can be the first half of `\r\n`, so it waits for the next chunk.
        if (end < 0 || (buffer[end] === "\r" && end === buffer.length - 1)) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1))
        if (line === "") {
          if (data.length) yield { type: type || "message", data: data.join("\n") }
          type = ""
          data = []
          continue
        }
        if (line.startsWith(":")) continue
        const colon = line.indexOf(":")
        const field = colon < 0 ? line : line.slice(0, colon)
        const text = colon < 0 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1))
        if (field === "event") type = text
        else if (field === "data") data.push(text)
      }
    }
  }
  finally {
    await reader.cancel().catch(() => undefined)
  }
}

export { readEvents }
export type { SyncStreamEvent }
