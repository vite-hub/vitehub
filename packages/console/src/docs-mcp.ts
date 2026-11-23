/** The public docs MCP server: stateless Streamable HTTP, with no sign-in. */
export const docsMcpUrl = "https://vitehub.dev/mcp"

/** An MCP tool result, as the docs server sends it. */
export interface DocsToolResult {
  content: Array<{ type: string, [key: string]: unknown }>
  structuredContent?: Record<string, unknown>
  isError: boolean
}

function failed(text: string): DocsToolResult {
  return { content: [{ text, type: "text" }], isError: true }
}

const requestId = 1

function messages(body: string, type: string | null): unknown[] {
  if (!type?.includes("text/event-stream")) return [JSON.parse(body)]
  return body.split(/\r\n\r\n|\n\n|\r\r/).flatMap((event) => {
    const data = event.split(/\r\n|\n|\r/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(line.startsWith("data: ") ? 6 : 5))
      .join("\n")
    return data.trim() ? [JSON.parse(data)] : []
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Call one tool of the docs MCP server. A failure is a tool error that says what went wrong, never a throw. */
export async function callDocsTool(name: string, args: Record<string, unknown>, send: typeof fetch = fetch): Promise<DocsToolResult> {
  let response: Response
  try {
    response = await send(docsMcpUrl, {
      body: JSON.stringify({ id: requestId, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } }),
      headers: { "accept": "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
  }
  catch {
    return failed(`The docs server at ${docsMcpUrl} did not answer. Try again, or read https://vitehub.dev/llms.txt.`)
  }
  if (!response.ok) return failed(`The docs server answered ${response.status}. Try again, or read https://vitehub.dev/llms.txt.`)
  let received: unknown[]
  try {
    received = messages(await response.text(), response.headers.get("content-type"))
  }
  catch {
    return failed("The docs server sent an answer that is not JSON-RPC.")
  }
  if (!received.every(isRecord)) return failed("The docs server sent an answer that is not JSON-RPC.")
  const answer = received.find(item => item.id === requestId && ("result" in item || "error" in item))
  if (!answer) return failed("The docs server did not answer the request.")
  if (isRecord(answer.error)) return failed(typeof answer.error.message === "string" ? answer.error.message : `${name} failed on the docs server.`)
  const result = answer.result
  if (!isRecord(result) || !Array.isArray(result.content)) return failed("The docs server sent a tool result without content.")
  return {
    // SAFETY: An MCP tool result has a `content` array of blocks, and each block has a `type`.
    content: result.content as DocsToolResult["content"],
    ...(isRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
    isError: result.isError === true,
  }
}
