/** Read the newline-delimited metadata without decoding the cached response body. */
export async function readDerivedHeader(body: Blob): Promise<{ text: string, bodyOffset: number } | undefined> {
  const decoder = new TextDecoder()
  let text = ""
  for (let offset = 0; offset < body.size; offset += 4096) {
    const chunk = new Uint8Array(await body.slice(offset, offset + 4096).arrayBuffer())
    const boundary = chunk.indexOf(10)
    if (boundary >= 0) {
      text += decoder.decode(chunk.subarray(0, boundary))
      return { text, bodyOffset: offset + boundary + 1 }
    }
    text += decoder.decode(chunk, { stream: true })
  }
  return undefined
}
