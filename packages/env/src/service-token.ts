import { isViteHubBearerSecretEqual } from "@vite-hub/internal/secret"
import { defineErrors } from "@vite-hub/runtime"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { HTTPError } from "h3"

import { runtimeEnv } from "./internal/runtime-env.ts"

import type { Result, ViteHubContext } from "@vite-hub/runtime"

const serviceTokenErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/env/diagnostics",
  codes: {
    // Runtime errors. `checkServiceToken()` returns them as `[error, undefined]`.
    ENV_SERVICE_TOKEN_INVALID: {
      docs: "https://vitehub.dev/docs/env/diagnostics/env_service_token_invalid",
      why: ({ name }: { name: string }) => `The request has no \`Authorization: Bearer\` token that matches a token in \`${name}\`.`,
      fix: "Send the header `Authorization: Bearer <token>` with a token that the server variable holds. The variable holds one token, or a comma-separated list while you rotate tokens.",
    },
    ENV_SERVICE_TOKEN_UNSET: {
      docs: "https://vitehub.dev/docs/env/diagnostics/env_service_token_unset",
      why: ({ name }: { name: string }) => `\`${name}\` has no token on this server, so every request is refused.`,
      fix: "Set the variable to a long random token, such as the output of `openssl rand -base64 32`: in `.env` for `vite dev`, and as a secret on the host for production. To rotate, set the old and the new token separated by a comma, then remove the old one.",
    },
  },
})

/** The codes that `checkServiceToken()` returns. */
export type ServiceTokenErrorCode = "ENV_SERVICE_TOKEN_INVALID" | "ENV_SERVICE_TOKEN_UNSET"

function readTokens(value: unknown): string[] {
  return typeof value === "string" ? value.split(",").map(token => token.trim()).filter(Boolean) : []
}

/**
 * Checks that a request carries `Authorization: Bearer <token>` with a token from the host variable `name`, and
 * returns `[error, undefined]`. The variable holds one token, or a comma-separated list, so the old and the new token
 * both pass while you rotate. It compares in constant time. Without a token in the variable, every request fails with
 * `ENV_SERVICE_TOKEN_UNSET`.
 *
 * ```ts [server/api/health.get.ts]
 * import { defineEventHandler } from "h3"
 * import { checkServiceToken } from "vite-hub/env"
 *
 * export default defineEventHandler((event) => {
 *   const [error] = checkServiceToken(event, "ADMIN_TOKEN")
 *   return error ? { ok: true } : { ok: true, queue: 3 }
 * })
 * ```
 */
export function checkServiceToken(event: Request | ViteHubContext, name: string): Result<void, ServiceTokenErrorCode> {
  const tokens = readTokens(runtimeEnv(event)[name])
  if (!tokens.length) return [serviceTokenErrors.ENV_SERVICE_TOKEN_UNSET({ name }), undefined]
  const authorization = getStandardContext(event).req.headers.get("authorization")
  // Compare with every token, so the time does not show which token matched.
  let valid = false
  for (const token of tokens) valid = isViteHubBearerSecretEqual(authorization, token) || valid
  return valid ? [undefined, undefined] : [serviceTokenErrors.ENV_SERVICE_TOKEN_INVALID({ name }), undefined]
}

/**
 * Returns when a request carries `Authorization: Bearer <token>` with a token from the host variable `name`. Otherwise
 * it throws an `HTTPError`: `401` with `ENV_SERVICE_TOKEN_INVALID`, or `503` with `ENV_SERVICE_TOKEN_UNSET` when the
 * variable has no token. Use it for routes that scripts, runners, and webhooks call.
 *
 * ```ts [server/api/ingest.post.ts]
 * import { defineEventHandler } from "h3"
 * import { requireServiceToken } from "vite-hub/env"
 *
 * export default defineEventHandler((event) => {
 *   requireServiceToken(event, "INGEST_TOKEN")
 *   return { ok: true }
 * })
 * ```
 */
export function requireServiceToken(event: Request | ViteHubContext, name: string): void {
  const [error] = checkServiceToken(event, name)
  if (!error) return
  const unset = error.code === "ENV_SERVICE_TOKEN_UNSET"
  throw new HTTPError({
    cause: error,
    data: { code: error.code },
    headers: unset ? undefined : { "www-authenticate": "Bearer" },
    message: error.message,
    status: unset ? 503 : 401,
  })
}
