import { forgeProvider, type GitHubProvider } from "@vite-hub/forge"

/** One request that the test GitHub API received. */
export interface GitHubTestRequest {
  method: string
  /** The URL path, for example `/repos/acme/app/pulls/12`. */
  path: string
  url: URL
  /** The parsed JSON body of a write or a GraphQL request. */
  body?: unknown
  /** The GraphQL operation name and variables. */
  operationName?: string
  variables?: Record<string, unknown>
  /** The GraphQL document. */
  query?: string
  signal?: AbortSignal
}

/**
 * Answers one request. Return a JSON body (GraphQL: the `data` object), a `Response`,
 * or undefined for a 404.
 */
export type GitHubTestRoute = (request: GitHubTestRequest) => unknown | Promise<unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** A `forges` GitHub provider backed by `route`, and the requests it sent. */
export async function githubForge(route: GitHubTestRoute): Promise<{ provider: GitHubProvider, calls: GitHubTestRequest[], fetch: typeof fetch }> {
  const calls: GitHubTestRequest[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text()
    let body: unknown
    try { body = text ? JSON.parse(text) : undefined }
    catch { body = text }
    const graphql = url.pathname === "/graphql" ? record(body) : undefined
    const call: GitHubTestRequest = {
      method: request.method,
      path: url.pathname,
      url,
      body,
      ...(graphql ? {
        operationName: typeof graphql.operationName === "string" ? graphql.operationName : undefined,
        variables: record(graphql.variables) ?? {},
        query: typeof graphql.query === "string" ? graphql.query : undefined,
      } : {}),
      signal: request.signal,
    }
    calls.push(call)
    const result = await route(call)
    if (result instanceof Response) return result
    if (result === undefined) return Response.json({ message: "Not Found" }, { status: 404 })
    if (typeof result === "string") return new Response(result, { headers: { "content-type": "text/plain" } })
    return Response.json(graphql ? { data: result } : result)
  }
  const provider = await forgeProvider({ forge: "github", token: "test-token", fetch })
  return { provider, calls, fetch }
}

/** A GitHub error response with the status and message that GitHub sends. */
export function githubError(status: number, message = "GitHub error"): Response {
  return Response.json({ message }, { status })
}
