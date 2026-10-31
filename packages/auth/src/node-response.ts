import { readSetCookies } from "./set-cookie.ts"

import type { ServerResponse } from "node:http"

export async function sendWebResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status
  target.statusMessage = response.statusText
  const setCookieHeaders = readSetCookies(response.headers)
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie" && setCookieHeaders.length > 0) return
    target.appendHeader(key, value)
  })
  for (const value of setCookieHeaders) {
    target.appendHeader("set-cookie", value)
  }

  if (!response.body) {
    target.end()
    return
  }

  const reader = response.body.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      target.write(Buffer.from(chunk.value))
    }
  }
  finally {
    target.end()
    reader.releaseLock()
  }
}
