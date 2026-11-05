import type { ViteHubContext } from "@vite-hub/runtime"

/**
 * An H3 1 event, such as a Nuxt 4 server event, for `request`: `event.req` is Node's request, which has no Web body
 * methods, and the body comes from the Node stream. `params` become `context.params`.
 */
export async function h3V1Event(request: Request, params?: Record<string, string>): Promise<ViteHubContext<{ context: { params?: Record<string, string> } }>> {
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
  const url = new URL(request.url)
  const headers: Record<string, string> = { host: url.host }
  for (const [name, value] of request.headers) headers[name] = value
  const responseHeaders = new Map<string, number | string | string[]>()
  const nodeRequest = {
    headers,
    method: request.method,
    url: `${url.pathname}${url.search}`,
    async *[Symbol.asyncIterator]() {
      if (body) yield body
    },
  }
  // SAFETY: The object has the fields of an H3 1 event that Standard Context reads; getStandardContext() sets `~standard`.
  return {
    context: params ? { params } : {},
    node: {
      req: nodeRequest,
      res: {
        getHeader: (name: string) => responseHeaders.get(name),
        getHeaders: () => Object.fromEntries(responseHeaders),
        removeHeader: (name: string) => responseHeaders.delete(name),
        setHeader: (name: string, value: number | string | string[]) => responseHeaders.set(name, value),
        statusCode: 200,
      },
    },
    req: nodeRequest,
  } as unknown as ViteHubContext<{ context: { params?: Record<string, string> } }>
}
