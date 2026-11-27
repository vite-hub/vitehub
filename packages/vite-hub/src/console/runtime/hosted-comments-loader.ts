/**
 * The Nitro plugin of the Hosted Comments pill, in an app that the ViteHub Console links and that has no app Comments.
 * It adds the loader to the HTML pages of the app. See `server/hosted-comments.ts`.
 */
export default function viteHubConsoleHostedComments(nitroApp: unknown): void {
  if (nitroApp === null || typeof nitroApp !== "object") return
  const h3: unknown = Reflect.get(nitroApp, "h3")
  const perRequestFetchOwner: object = h3 !== null && typeof h3 === "object" && Reflect.get(h3, "fetch") instanceof Function ? h3 : nitroApp
  const fetch: unknown = Reflect.get(perRequestFetchOwner, "fetch")
  if (!(fetch instanceof Function)) return
  Reflect.set(perRequestFetchOwner, "fetch", async (request: unknown, ...rest: unknown[]) => {
    const response: unknown = await Reflect.apply(fetch, perRequestFetchOwner, [request, ...rest])
    if (!(response instanceof Response) || !(request instanceof Request)) return response
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) return response
    const { withHostedComments } = await import("./server/hosted-comments.ts")
    return withHostedComments(request, response)
  })
}
