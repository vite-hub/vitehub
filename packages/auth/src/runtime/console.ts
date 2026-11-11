// Structured readers retain filters, cursors, and window totals for the later Activity and Overview views.
export { aggregateAuthEvents, listAuthEvents } from "../server.ts"

// The Console reads app Auth for its own request URL and `baseURL`. Apps call `useAuth(event)`.
export { authForRequest } from "../auth-instance.ts"
