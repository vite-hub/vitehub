/**
 * The docs tools of the ViteHub MCP forward each call to the public docs MCP server of vitehub.dev, so the Console
 * serves the same pages without a copy of the docs.
 */

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

/** The JSON-RPC message of an answer. The docs server answers with one Server-Sent Event or with plain JSON. */
function message(body: string, type: string | null): unknown {
  if (!type?.includes("text/event-stream")) return JSON.parse(body)
  const data = body.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n")
  return JSON.parse(data)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Call one tool of the docs MCP server. A failure is a tool error that says what went wrong, never a throw. */
export async function callDocsTool(name: string, args: Record<string, unknown>, send: typeof fetch = fetch): Promise<DocsToolResult> {
  let response: Response
  try {
    response = await send(docsMcpUrl, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } }),
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
  let answer: unknown
  try {
    answer = message(await response.text(), response.headers.get("content-type"))
  }
  catch {
    return failed("The docs server sent an answer that is not JSON-RPC.")
  }
  if (!isRecord(answer)) return failed("The docs server sent an answer that is not JSON-RPC.")
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
