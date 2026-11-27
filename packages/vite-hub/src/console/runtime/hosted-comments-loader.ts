/**
 * The Nitro plugin of the Hosted Comments pill, in an app that the ViteHub Console links and that has no app Comments.
 * It adds the loader to the HTML pages of the app. See `server/hosted-comments.ts`.
 */
export default function viteHubConsoleHostedComments(nitroApp: unknown): void {
  if (nitroApp === null || typeof nitroApp !== "object") return
  const fetch: unknown = Reflect.get(nitroApp, "fetch")
  if (!(fetch instanceof Function)) return
  Reflect.set(nitroApp, "fetch", async (request: unknown, ...rest: unknown[]) => {
    const response: unknown = await Reflect.apply(fetch, nitroApp, [request, ...rest])
    if (!(response instanceof Response) || !(request instanceof Request)) return response
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) return response
    const { withHostedComments } = await import("./server/hosted-comments.ts")
    return withHostedComments(request, response)
  })
}
