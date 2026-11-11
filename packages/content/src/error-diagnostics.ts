import { defineDiagnostics } from "nostics"

export const contentErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/content/diagnostics",
  codes: {
    CONTENT_R0001: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0002: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0003: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0004: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0006: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0007: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0008: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0009: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0010: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0011: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0012: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0013: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0014: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0015: {
      fix: "Start `vite dev` in this project, or pass `--url <origin>` of a running or deployed app. `VITEHUB_DEV_SERVER_URL` also names a server.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0016: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0017: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0018: {
      fix: "Import `sqlite` from `vite-hub/content/sqlite` in `server/content.ts`, so ViteHub loads SQLite WASM while the Worker starts. Cloudflare Workers compile WebAssembly only at startup.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    /** A new commit of a `github()` Source failed validation, so the head stays on the last valid commit. */
    CONTENT_R0019: {
      fix: "Fix the document in the repository and push a new commit, then call `content.sources.advance()`. `content.sources.head()` shows the rejected commit and the reason.",
      why: ({ source, sha, reason, head }: { source: string, sha: string, reason: string, head: string | null }) => `[vitehub] Commit ${sha} of Content source ${JSON.stringify(source)} failed validation, so Content keeps ${head ? `commit ${head}` : "no head"}: ${reason}`,
    },
    /** A `github()` Source has no token, so it has no head commit. */
    CONTENT_R0020: {
      fix: "Set `VITEHUB_GITHUB_TOKEN` in the Server Env, or pass `github({ auth })`. Content then serves one validated commit at a time from ViteHub KV.",
      why: ({ source }: { source: string }) => `[vitehub] Content source ${JSON.stringify(source)} reads GitHub without a token, so it has no head commit. Each load reads the latest commit of its branch without validation.`,
    },
    /** A `github()` Source has a token, but the app has no KV store for its head commit. */
    CONTENT_R0021: {
      fix: "Remove `kv: false` from `vitehub()`, or install `@vite-hub/kv`. ViteHub turns KV on when `server/content.ts` imports `github()`. If `server/content.ts` gets its Sources from another file, enable KV yourself. Content keeps the head commit in the `default` KV store.",
      why: ({ source }: { source: string }) => `[vitehub] Content source ${JSON.stringify(source)} has a GitHub token, but the app has no KV store, so it has no head commit. Each load reads the latest commit of its branch without validation.`,
    },
    /** The KV store failed while Content read or stored the head commit of a `github()` Source. */
    CONTENT_R0022: {
      fix: "Check the `default` KV store of the app. On Cloudflare, bind a KV namespace as `KV`. On Vercel, set `KV_REST_API_URL` and `KV_REST_API_TOKEN`. `vitehub kv get <key>` reads the head.",
      why: ({ source, key, reason }: { source: string, key: string, reason: string }) => `[vitehub] The KV store failed on ${JSON.stringify(key)} for Content source ${JSON.stringify(source)}: ${reason}. Reads do not fail: they serve the commit that this server already serves, or the latest commit of the branch without validation, and try KV again after 5 seconds.`,
    },
    /** A request to the GitHub push webhook route has no valid `X-Hub-Signature-256` header. */
    CONTENT_R0024: {
      fix: "Set the webhook secret in GitHub to the value of `VITEHUB_GITHUB_WEBHOOK_SECRET` in the Server Env, and set the content type to `application/json`. GitHub shows the failed delivery under Settings, Webhooks, Recent Deliveries.",
      why: ({ delivery }: { delivery: string | null }) => `[vitehub] The GitHub webhook delivery ${delivery ?? "without an id"} has no valid X-Hub-Signature-256 signature, so Content ignored it.`,
    },
    /** A signed push names a repository that no `github()` Source of Content reads. */
    CONTENT_R0025: {
      fix: "Point the webhook at the app whose `server/content.ts` reads this repository with `github({ repo })`, or remove the webhook from the repository.",
      why: ({ repo, heads }: { repo: string, heads: string }) => `[vitehub] Content received a GitHub push for ${repo}, but no github() Source reads that repository. Sources with a head: ${heads}.`,
    },
    /** The GitHub push webhook route has no secret, so it is disabled. */
    CONTENT_R0026: {
      fix: "Set `VITEHUB_GITHUB_WEBHOOK_SECRET` in the Server Env to the secret of the GitHub webhook. Without it, the head of each `github()` Source moves at most once per hour.",
      why: () => "[vitehub] The Content GitHub webhook route answers 404, because the Server Env has no VITEHUB_GITHUB_WEBHOOK_SECRET.",
    },
  },
})
