export type { ViteHubHost } from "@vite-hub/internal/deployment"
export { detectHost } from "@vite-hub/internal/deployment"

/**
 * Adds the `module` export condition to a Cloudflare build. Vite resolves server code with it, and Nitro does not.
 * Without it, a package that keeps its ESM build under `module`, such as `@opentelemetry/semantic-conventions` (which
 * Better Auth imports), ships its whole CommonJS build in the Worker instead of the few exports that the app uses.
 */
export function cloudflareExportConditions(conditions: unknown): string[] {
  const current = Array.isArray(conditions) ? conditions.filter((condition): condition is string => String(condition) === condition) : []
  return current.includes("module") || current.includes("!module") ? current : [...current, "module"]
}
