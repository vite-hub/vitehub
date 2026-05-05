export interface ChatStreamThread {
  post(message: string | AsyncIterable<unknown>): Promise<unknown>
}

export interface PostChatStreamOptions {
  noTextFallback?: string | ((stream: AsyncIterable<unknown>) => string | Promise<string>)
  onText?: () => void
}

function streamChunkText(chunk: unknown): string | undefined {
  if (typeof chunk === "string") {
    return chunk
  }
  if (!chunk || typeof chunk !== "object" || !("type" in chunk)) {
    return undefined
  }

  const part = chunk as { delta?: unknown, text?: unknown, textDelta?: unknown, type?: unknown }
  const text = part.delta ?? part.text ?? part.textDelta
  return part.type === "text-delta" && typeof text === "string" ? text : undefined
}

function watchTextStream<TStream extends AsyncIterable<unknown>>(stream: TStream, onText: () => void): TStream {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of stream) {
        if (streamChunkText(chunk)) {
          onText()
        }
        yield chunk
      }
    },
  } as unknown as TStream
}

export async function postChatStream<TStream extends AsyncIterable<unknown>>(
  thread: ChatStreamThread,
  stream: TStream,
  options: PostChatStreamOptions = {},
): Promise<{ sawText: boolean }> {
  let sawText = false
  await thread.post(watchTextStream(stream, () => {
    sawText = true
    options.onText?.()
  }))
  if (!sawText && options.noTextFallback) {
    const fallback = typeof options.noTextFallback === "function"
      ? await options.noTextFallback(stream)
      : options.noTextFallback
    await thread.post(fallback)
  }
  return { sawText }
}
