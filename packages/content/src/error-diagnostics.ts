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
      fix: "Enable ViteHub KV in `vite.config.ts`. Content keeps the head commit in the `default` KV store. On Cloudflare, bind a KV namespace as `KV`.",
      why: ({ source }: { source: string }) => `[vitehub] Content source ${JSON.stringify(source)} has a GitHub token, but the app has no KV store, so it has no head commit. Each load reads the latest commit of its branch without validation.`,
    },
  },
})
