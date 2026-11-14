/** The request header that names the page of an Agent run. `connectPage()` sends it, and `page()` reads it. */
export const pageHeader = "x-vitehub-page"
/** The Realtime Definition of page rooms. ViteHub adds it when an app has Agents and Realtime. */
export const pageRealtimeDefinition = "agent-pages"
/** The Invocation context key that names the page when a run has no request, such as `{ page: { id } }`. */
export const pageContextKey = "page"
