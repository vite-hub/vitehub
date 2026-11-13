import { detectHost as detectDeploymentHost } from "@vite-hub/internal/deployment"
import { getActiveCloudflareEnv, getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env-lookup"

import { defineErrors } from "./result.ts"

import type { ViteHubHost } from "@vite-hub/internal/deployment"
import type { ErrorCatalog, Result } from "./result.ts"
import type { ViteHubContext } from "./standard-context.ts"

declare global {
  /** `wrangler types` adds the app's bindings to `Cloudflare.Env`. ViteHub reads it to type `getHostBinding()`. */
  namespace Cloudflare {
    interface Env {}
  }
}

/** A host that ViteHub builds for. */
export type { ViteHubHost } from "@vite-hub/internal/deployment"

/** The codes that `getHostBinding()` returns. */
export type HostBindingErrorCode = "RUNTIME_HOST_BINDING_NOT_FOUND" | "RUNTIME_HOST_BINDINGS_UNAVAILABLE"

const hostBindingCodes = {
  RUNTIME_HOST_BINDINGS_UNAVAILABLE: {
    why: ({ name }: { name: string }) => `This code runs without host bindings, so the binding "${name}" is not available. Only Cloudflare Workers give bindings.`,
    fix: "Build with `host: \"cloudflare\"`, or handle the error to use another source in this runtime, for example in `vite dev` on Node.",
  },
  RUNTIME_HOST_BINDING_NOT_FOUND: {
    why: ({ name }: { name: string }) => `The Worker has no binding named "${name}".`,
    fix: "Declare the binding in the Wrangler config of the app, then run `wrangler types` to update `Cloudflare.Env`.",
  },
}

const hostBindingErrors: ErrorCatalog<typeof hostBindingCodes> = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/development/diagnostics",
  codes: hostBindingCodes,
})

/**
 * Returns the host that this code builds or runs on, or `undefined` when nothing names one.
 * It reads `VITEHUB_HOST`, `NITRO_PRESET`, `SERVER_PRESET`, then the build variables of Cloudflare Workers Builds
 * (`WORKERS_CI`), Netlify, Vercel, and Deno Deploy. Inside a Cloudflare Worker, it returns `"cloudflare"`.
 * `vitehub()` uses the same detection when `host` is omitted.
 *
 * @example
 * ```ts
 * import { detectHost } from "vite-hub/runtime"
 *
 * const host = detectHost() ?? "node"
 * ```
 */
export function detectHost(env: Record<string, string | undefined> = processEnv()): ViteHubHost | undefined {
  return detectDeploymentHost(env) ?? (globalThis.navigator?.userAgent === "Cloudflare-Workers" ? "cloudflare" : undefined)
}

function processEnv(): Record<string, string | undefined> {
  return globalThis.process?.env ?? {}
}

/**
 * Reads one raw binding of the host, such as an R2 bucket, a Durable Object namespace, or a variable of a Cloudflare
 * Worker. Use it for host features that no ViteHub primitive covers. It works in request handlers, Schedules, Queues,
 * and Workflows. Pass the request `event` when you have one: an H3 event, a Standard Context, or a host context with `env`.
 *
 * Run `wrangler types` to type the result from the app's bindings.
 * Returns `RUNTIME_HOST_BINDINGS_UNAVAILABLE` when the code runs without host bindings, such as on Node, and
 * `RUNTIME_HOST_BINDING_NOT_FOUND` when the Worker has no binding with that name.
 *
 * @example
 * ```ts
 * import { getHostBinding } from "vite-hub/runtime"
 *
 * const [error, bucket] = getHostBinding("VIDEOS", event)
 * if (error) return new Response(null, { status: 404 })
 * const object = await bucket.get("intro.mp4")
 * ```
 */
export function getHostBinding<TName extends keyof Cloudflare.Env & string>(name: TName, event?: object): Result<Cloudflare.Env[TName], HostBindingErrorCode>
export function getHostBinding<T = unknown>(name: string, event?: object): Result<T, HostBindingErrorCode>
export function getHostBinding(name: string, event?: object): Result<unknown, HostBindingErrorCode> {
  const env = (event && hostBindingsOf(event)) ?? getActiveCloudflareEnv()
  if (!env) return [hostBindingErrors.RUNTIME_HOST_BINDINGS_UNAVAILABLE({ name }), undefined]
  const binding: unknown = Object.hasOwn(env, name) ? env[name] : undefined
  if (binding === undefined) return [hostBindingErrors.RUNTIME_HOST_BINDING_NOT_FOUND({ name }), undefined]
  return [undefined, binding]
}

function hostBindingsOf(event: object): Record<string, unknown> | undefined {
  // A Nitro plugin sets Standard Context for each request. Events without it keep the bindings where the host put them.
  return (event as Partial<ViteHubContext>)["~standard"]?.runtime?.cloudflare?.env ?? getCloudflareEnv(event, { fallback: false })
}
