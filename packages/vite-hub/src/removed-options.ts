import { isRecord } from "@vite-hub/internal/object"
import { type ViteHubOptionValueForm, viteHubErrorDiagnostics } from "./error-diagnostics.ts"
import type { ViteHubOptions } from "./plugins.ts"

/**
 * Top-level `vitehub()` options that ViteHub removed or renamed: why each one is gone and how to fix it. The build
 * fails on them, and the `vitehub/valid-vitehub-options` Doctor rule reports them in the editor, from this one table.
 */
export const removedViteHubOptions: Readonly<Record<string, { why: string, fix: string }>> = {
  preset: {
    why: "`preset` was renamed to `host`. Without `host`, ViteHub detects the host, and builds for Node when it finds none.",
    fix: "Rename `preset` to `host`. `vitehub migrate` renames it.",
  },
  sandbox: {
    why: "`sandbox` was renamed to `sandboxTask`.",
    fix: "Rename `sandbox` to `sandboxTask: true`. `vitehub migrate` renames it.",
  },
  devtools: {
    why: "The `devtools` option was removed with the browser DevTools.",
    fix: "Remove `devtools`. Use the ViteHub Console with `console: true`. `vitehub migrate` removes it.",
  },
  "observability.logs": {
    why: "`observability.logs` moved to the top-level `logs` key.",
    fix: "Move it to `vitehub({ logs: ... })`. `vitehub migrate` moves it.",
  },
  "logs.evlog": {
    why: "`logs.evlog` moved to `observability.evlog`.",
    fix: "Move Evlog settings to `vitehub({ observability: { evlog: ... } })`. `vitehub migrate` moves them.",
  },
  "cloudflare.secretsFile": {
    why: "`cloudflare.secretsFile` was removed. `vitehub deploy` uploads the Worker secrets that the app reads with each new version.",
    fix: "Remove `cloudflare.secretsFile`. Keep the values in the shell or in `.env.production`, and deploy with `vitehub deploy`.",
  },
  contentImportBase: {
    why: "`contentImportBase` was removed. ViteHub always imports Content from `vite-hub/content`.",
    fix: "Remove `contentImportBase`.",
  },
}

type ViteHubOptionForm = ViteHubOptionValueForm | "checked-by-owner"

const viteHubOptionForms: Readonly<Record<keyof ViteHubOptions, ViteHubOptionForm>> = {
  agent: "feature",
  auth: "checked-by-owner",
  blob: "feature",
  browser: "feature",
  bundle: "boolean",
  cache: "feature",
  channels: "feature",
  cloudflare: "object",
  comments: "feature",
  connections: "checked-by-owner",
  console: "checked-by-owner",
  dataDir: "checked-by-owner",
  database: "feature",
  deploy: "object",
  device: "off-or-object",
  docker: "boolean",
  email: "feature",
  env: "off-or-object",
  health: "feature",
  host: "checked-by-owner",
  i18n: "object",
  kv: "checked-by-owner",
  logs: "feature",
  mcp: "feature",
  name: "string",
  node: "object",
  observability: "feature",
  publicUrl: "string-or-function",
  queue: "checked-by-owner",
  rateLimit: "feature",
  realtime: "feature",
  redirects: "object",
  sameOriginWrites: "feature",
  sandboxTask: "feature",
  schedule: "feature",
  security: "object",
  seo: "object",
  systemd: "feature",
  trustProxy: "boolean",
  webContainer: "object",
  workflow: "feature",
  workspace: "feature",
}

const acceptsForm: Readonly<Record<ViteHubOptionValueForm, (value: unknown) => boolean>> = {
  "boolean": value => typeof value === "boolean",
  "feature": value => typeof value === "boolean" || isRecord(value),
  "object": isRecord,
  "off-or-object": value => value === false || isRecord(value),
  "string": value => typeof value === "string",
  "string-or-function": value => typeof value === "string" || typeof value === "function",
}

/** Whether `key` is a top-level `vitehub()` option. */
export function isViteHubOptionKey(key: string): boolean {
  return Object.hasOwn(viteHubOptionForms, key)
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row++) {
    const current = [row]
    for (let column = 1; column <= right.length; column++) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      current.push(Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + cost))
    }
    previous = current
  }
  return previous[right.length]!
}

/** The `vitehub()` option that `key` most likely means, such as `rateLimit` for `rate-limit`, or undefined. */
export function closestViteHubOptionKey(key: string): string | undefined {
  const normalize = (value: string) => value.toLowerCase().replace(/[-_\s]/g, "")
  const keys = Object.keys(viteHubOptionForms)
  const same = keys.find(candidate => normalize(candidate) === normalize(key))
  if (same) return same
  let best: { key: string, distance: number } | undefined
  for (const candidate of keys) {
    const distance = editDistance(normalize(key), normalize(candidate))
    if (distance <= Math.min(2, Math.floor(candidate.length / 2)) && (!best || distance < best.distance)) best = { key: candidate, distance }
  }
  return best?.key
}

/**
 * Fails with `VITE_HUB_B0024` when `options` set a removed or renamed option, with `VITE_HUB_UNKNOWN_OPTION` when a
 * top-level key is not a ViteHub option, and with `VITE_HUB_INVALID_OPTION` when an option has a value of the wrong
 * type, such as `blob: 1`. ViteHub would otherwise ignore them, or fail later with an error that does not name the option.
 */
export function assertViteHubOptions(options: object, where: string): void {
  for (const [key, { why, fix }] of Object.entries(removedViteHubOptions)) {
    const value = key.split(".").reduce<unknown>((value, part) => value !== null && typeof value === "object" ? Reflect.get(value, part) : undefined, options)
    if (value === undefined) continue
    throw viteHubErrorDiagnostics.VITE_HUB_B0024({ message: `[vitehub] \`${key}\` in ${where} is no longer a ViteHub option. ${why} ${fix}` })
  }
  const unknown = Object.keys(options).find(key => !isViteHubOptionKey(key) && Reflect.get(options, key) !== undefined)
  if (unknown) throw viteHubErrorDiagnostics.VITE_HUB_UNKNOWN_OPTION({ key: unknown, suggestion: closestViteHubOptionKey(unknown) ?? "", where })
  for (const [key, form] of Object.entries(viteHubOptionForms)) {
    const value: unknown = Reflect.get(options, key)
    if (value === undefined || form === "checked-by-owner" || acceptsForm[form](value)) continue
    throw viteHubErrorDiagnostics.VITE_HUB_INVALID_OPTION({ form, key, value: describeValue(value), where })
  }
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "an array"
  if (value === null) return "`null`"
  if (typeof value === "function") return "a function"
  if (isRecord(value)) return "an object"
  return `\`${JSON.stringify(value)}\``
}
