// The libSQL driver of the default Agent Invocation journal. The generated Nitro plugin loads it only when the build
// can select SQLite or libSQL, so a Cloudflare build that stores the journal in D1 or memory does not ship libSQL.
export { openDefaultLibsqlJournal } from "@vite-hub/agent/internal/default-invocations-libsql"
