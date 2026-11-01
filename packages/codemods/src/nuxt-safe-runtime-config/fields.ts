import { snakeCase } from "scule"

export type EnvFieldKind = "boolean" | "enum" | "number" | "string"

export type LiteralValue = boolean | number | string

/** One runtime config value that moves to an Env declaration. */
export interface EnvField {
  section: "public" | "server"
  /** Path in Nuxt `runtimeConfig`, without the `public` segment. */
  configPath: string[]
  /** Path in Public Env or Server Env. Public Env paths have one segment. */
  envPath: string[]
  /** Host variable that Nuxt mapped to this path, such as `NUXT_PUBLIC_API_BASE`. */
  variable: string
  /** Other host variables to read after `variable`. */
  extraVariables?: string[]
  kind: EnvFieldKind
  values?: string[]
  required: boolean
  secret: boolean
  default?: LiteralValue
}

/** Nuxt's rule: `NUXT_` and the upper snake case path. Public paths start with `PUBLIC`. */
export function nuxtVariableName(section: EnvField["section"], configPath: readonly string[]): string {
  const path = section === "public" ? ["public", ...configPath] : configPath
  return `NUXT_${snakeCase(path.join("_")).toUpperCase()}`
}

/** Public Env is flat, so a nested public path joins its segments in camel case. */
export function flatPublicName(configPath: readonly string[]): string {
  return configPath
    .map((segment, index) => index === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("")
}

function words(path: readonly string[]): string[] {
  return path.flatMap(segment => segment
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .map(word => word.toLowerCase())
    .filter(Boolean))
}

const credentialWords = new Set(["secret", "secrets", "token", "tokens", "password", "passwd", "pwd", "key", "keys", "credential", "credentials", "dsn", "apikey"])
const connectionWords = new Set(["database", "db", "connection", "postgres", "postgresql", "mysql", "redis", "mongo", "mongodb", "sql", "libsql", "turso"])
const urlWords = new Set(["url", "uri", "string"])

/** True when a server path looks like a credential, a DSN, or a database or connection URL. */
export function looksSecret(path: readonly string[]): boolean {
  const list = words(path)
  if (list.some(word => credentialWords.has(word))) return true
  return list.some(word => connectionWords.has(word)) && list.some(word => urlWords.has(word))
}

export function pathLabel(field: Pick<EnvField, "configPath" | "section">): string {
  return [...(field.section === "public" ? ["public"] : []), ...field.configPath].join(".")
}

/**
 * A follow-up whose location the codemod resolves after it writes nuxt.config: the new Env declaration,
 * a `runtimeConfig` key that stays, or a path in the `$schema` module.
 */
export interface PlannedFollowUp {
  message: string
  anchor?: { env: EnvField } | { runtimeConfig: string } | { schema: string } | { file: string, line: number }
}
