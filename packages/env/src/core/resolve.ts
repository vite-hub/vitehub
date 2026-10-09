import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"

import { parseSchema } from "../schema.ts"
import { runtimeValueSchema } from "./declarations.ts"
import { envValueTypeName, parseEnvValue } from "./values.ts"
import { hasRuntimeType } from "../internal/runtime-type.ts"
import { isViteHubError } from "@vite-hub/runtime"
import { envSourceFailed, invalidEnvDeclaration, isAbortError, missingRequiredEnv } from "./errors.ts"

import type {
  EnvBuildConfigOptions,
  EnvBuildStaticValue,
  EnvDiagnosticEntry,
  EnvMode,
  EnvRuntimeConfigOptions,
  EnvRuntimeStaticValue,
  EnvRuntimeRegistry,
  EnvSource,
  EnvSourceContext,
  EnvValueSchema,
  EnvVariableDeclaration,
  EnvViteConfigOptions,
  ResolvedEnvEntry,
} from "../types.ts"
import { envErrorDiagnostics } from "../error-diagnostics.ts"

const execFileAsync = promisify(execFile)

export function validateEnvConfigShape(config: EnvViteConfigOptions | undefined, _target: "vite"): void {
  if (!config) {
    return
  }

  const viteConfig = config as EnvViteConfigOptions
  for (const key of Object.keys(viteConfig)) {
    if (key !== "define" && key !== "public" && key !== "server") {
      const path = `env.${key}`
      throw invalidEnvDeclaration(path, `Invalid declaration at ${path}. Vite env config only supports env.public, env.define, and env.server.`)
    }
  }

  for (const [key, declaration] of Object.entries(viteConfig.public || {})) {
    assertEnvVariableDeclaration(`env.public.${key}`, declaration)
    if (declaration.mode !== "build") {
      const path = `env.public.${key}`
      throw invalidEnvDeclaration(path, `${path} must use mode: "build" in Vite config.`)
    }
    if (declaration.secret) {
      const path = `env.public.${key}`
      throw invalidEnvDeclaration(path, `${path} cannot be marked secret.`)
    }
  }

  validateBuildDeclarations(viteConfig.define, "env.define")
}

export function createSourceContext(input: {
  env: Record<string, string | undefined>
  mode: EnvMode
  rootDir: string
}): EnvSourceContext {
  return {
    build: {
      timestamp: () => new Date().toISOString(),
    },
    env: input.env,
    git: {
      branch: () => gitOutput(input.rootDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
      commit: options => gitOutput(input.rootDir, options?.short ? ["rev-parse", "--short", "HEAD"] : ["rev-parse", "HEAD"]),
      ref: async () => envValue(input.env, ["GIT_REF_NAME", "GITHUB_REF_NAME"]) ?? await gitOutput(input.rootDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
      sha: async options => {
        const value = envValue(input.env, ["GIT_SHA", "GITHUB_SHA"])
        if (value) return options?.short ? value.slice(0, 7) : value
        return gitOutput(input.rootDir, options?.short ? ["rev-parse", "--short", "HEAD"] : ["rev-parse", "HEAD"])
      },
      tag: async () => {
        const tag = envValue(input.env, ["GIT_TAG"])
        if (tag) return tag
        if (input.env.GITHUB_REF_TYPE === "tag") return envValue(input.env, ["GITHUB_REF_NAME"])
        return await gitOutput(input.rootDir, ["describe", "--tags", "--exact-match", "HEAD"]).catch(() => undefined)
      },
    },
    mode: input.mode,
    packageJson: () => readPackageJson(input.rootDir),
    rootDir: input.rootDir,
  }
}

function envValue(env: Record<string, string | undefined>, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value) return value
  }
}

export async function resolveBuildConfig(
  declarations: Record<string, EnvBuildConfigOptions | EnvBuildStaticValue | EnvVariableDeclaration> | undefined,
  input: {
    context: EnvSourceContext
    exposure: "compile-time replacement"
    prefix?: string | false
    section: "env.define"
    timing: string
  },
): Promise<{ diagnostics: EnvDiagnosticEntry[], values: Record<string, unknown> }> {
  assertUniqueBuildCanonicalNames(declarations, input.section, input.prefix)
  const diagnostics: EnvDiagnosticEntry[] = []
  const values: Record<string, unknown> = {}

  for (const [key, declaration] of Object.entries(declarations || {})) {
    const result = await resolveBuildConfigValue(declaration, `${input.section}.${key}`, { ...input, prefix: canonicalKey.test(key) ? input.prefix : false })
    values[key] = result.value
    diagnostics.push(...result.diagnostics)
  }

  return { diagnostics, values }
}

export async function resolveEnvEntries(
  declarations: Record<string, EnvVariableDeclaration> | undefined,
  input: {
    context: EnvSourceContext
    exposure: "build public" | "compile-time replacement" | "public runtime transport" | "server only"
    prefix?: string | false
    section: "env.define" | "env.public" | "env.server"
    timing: string
  },
): Promise<{ diagnostics: EnvDiagnosticEntry[], entries: ResolvedEnvEntry[] }> {
  assertUniqueBuildCanonicalNames(declarations, input.section, input.prefix)
  const entries: ResolvedEnvEntry[] = []
  const diagnostics: EnvDiagnosticEntry[] = []

  for (const [key, declaration] of Object.entries(declarations || {})) {
    const defaultValue = parseDeclarationDefault(declaration, `${input.section}.${key}`)
    const source = resolveEnvSource(declaration, `${input.section}.${key}`, canonicalKey.test(key) ? input.prefix : false)
    const resolvedSource = await resolveSourceValue(source, input.context)
    const defaulted = typeof resolvedSource.value === "undefined"
    const valueForSchema = defaulted ? defaultValue : resolvedSource.value
    if (typeof valueForSchema === "undefined") {
      if (declaration.required) {
        const path = `${input.section}.${key}`
        throw missingRequiredEnv(source.kind === "custom" ? "custom" : source.label, `Missing ${path} from ${source.label}.`, path)
      }
      entries.push({
        key,
        masked: declaration.secret,
        source: resolvedSource.label,
        type: declaration.type ?? "undefined",
        value: undefined,
      })
      diagnostics.push({
        exposed: declaration.secret ? `${input.exposure}, masked` : input.exposure,
        key: `${input.section}.${key}`,
        masked: declaration.secret,
        mode: declaration.mode,
        source: resolvedSource.label,
        status: "missing",
        timing: input.timing,
        type: declaration.type ?? "undefined",
      })
      continue
    }

    const value = parseSchema(declaration.schema, valueForSchema, `${input.section}.${key}`)
    const type = declaration.type ?? inferTypeName(value)
    entries.push({
      key,
      masked: declaration.secret,
      source: resolvedSource.label,
      type,
      value,
    })
    diagnostics.push({
      exposed: declaration.secret ? `${input.exposure}, masked` : input.exposure,
      key: `${input.section}.${key}`,
      masked: declaration.secret,
      mode: declaration.mode,
      source: defaulted ? "default" : resolvedSource.label,
      status: defaulted ? "defaulted" : "valid",
      timing: input.timing,
      type,
    })
  }

  return { diagnostics, entries }
}

export function createRuntimeRegistry(declarations: EnvRuntimeConfigOptions | undefined, options: { path?: string, prefix?: string | false } = {}): EnvRuntimeRegistry {
  const registry = buildRegistry(declarations, options.path ?? "env", options.prefix)
  assertUniqueCanonicalNames(registry, options.path ?? "env")
  return registry
}

// A key such as "nested.token" or "api-key" has no unambiguous upper snake case name.
const canonicalKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function claimCanonicalName(owners: Map<string, string>, canonical: string | undefined, path: string): void {
  if (canonical === undefined) return
  const owner = owners.get(canonical)
  if (owner !== undefined) {
    throw invalidEnvDeclaration(path, `${path} and ${owner} share the canonical variable name ${canonical}. Rename one, or set hubEnv({ prefix: false }).`)
  }
  owners.set(canonical, path)
}

function assertUniqueBuildCanonicalNames(declarations: unknown, path: string, prefix?: string | false): void {
  const owners = new Map<string, string>()
  const visit = (value: unknown, valuePath: string, valuePrefix?: string | false): void => {
    if (isEnvVariableDeclaration(value)) {
      const source = resolveEnvSource(value, valuePath, valuePrefix)
      if (source.kind === "env" && source.canonical !== false) claimCanonicalName(owners, source.canonical, valuePath)
      return
    }
    if (!isPlainRecord(value)) return
    for (const [key, child] of Object.entries(value)) {
      visit(child, `${valuePath}.${key}`, canonicalKey.test(key) ? valuePrefix : false)
    }
  }
  visit(declarations, path, prefix)
}

function assertUniqueCanonicalNames(registry: EnvRuntimeRegistry, path: string): void {
  const owners = new Map<string, string>()
  const visit = (value: unknown, valuePath: string): void => {
    if (!isPlainRecord(value)) return
    const source = value.source
    if (isPlainRecord(source) && source.kind === "env") {
      if (typeof source.canonical !== "string") return
      claimCanonicalName(owners, source.canonical, valuePath)
      return
    }
    if (value.kind === "literal" || isPlainRecord(source)) return
    for (const [key, child] of Object.entries(value)) visit(child, `${valuePath}.${key}`)
  }
  visit(registry, path)
}

async function resolveBuildConfigValue(
  declaration: EnvBuildConfigOptions | EnvBuildStaticValue | EnvVariableDeclaration,
  path: string,
  input: {
    context: EnvSourceContext
    exposure: "compile-time replacement"
    prefix?: string | false
    timing: string
  },
): Promise<{ diagnostics: EnvDiagnosticEntry[], value: unknown }> {
  if (isEnvVariableDeclaration(declaration)) {
    const defaultValue = parseDeclarationDefault(declaration, path)
    const source = resolveEnvSource(declaration, path, input.prefix)
    const resolvedSource = await resolveSourceValue(source, input.context)
    const defaulted = typeof resolvedSource.value === "undefined"
    const valueForSchema = defaulted ? defaultValue : resolvedSource.value
    if (typeof valueForSchema === "undefined") {
      if (declaration.required) {
        throw missingRequiredEnv(source.kind === "custom" ? "custom" : source.label, `Missing ${path} from ${source.label}.`, path)
      }
      return {
        diagnostics: [{
          exposed: input.exposure,
          key: path,
          masked: false,
          mode: declaration.mode,
          source: resolvedSource.label,
          status: "missing",
          timing: input.timing,
          type: declaration.type ?? "undefined",
        }],
        value: undefined,
      }
    }

    const value = parseSchema(declaration.schema, valueForSchema, path)
    const type = declaration.type ?? inferTypeName(value)
    return {
      diagnostics: [{
        exposed: input.exposure,
        key: path,
        masked: false,
        mode: declaration.mode,
        source: defaulted ? "default" : resolvedSource.label,
        status: defaulted ? "defaulted" : "valid",
        timing: input.timing,
        type,
      }],
      value,
    }
  }

  if (isBuildStaticValue(declaration)) {
    return { diagnostics: [], value: declaration }
  }

  if (!isPlainRecord(declaration)) {
    throw invalidEnvDeclaration(path, `Invalid build declaration at ${path}. Use env(), a serializable static value, or a nested object.`)
  }

  const value: Record<string, unknown> = {}
  const diagnostics: EnvDiagnosticEntry[] = []
  for (const [key, child] of Object.entries(declaration)) {
    const result = await resolveBuildConfigValue(child, `${path}.${key}`, { ...input, prefix: canonicalKey.test(key) ? input.prefix : false })
    value[key] = result.value
    diagnostics.push(...result.diagnostics)
  }

  return { diagnostics, value }
}

function parseDeclarationDefault(declaration: EnvVariableDeclaration, path: string): unknown {
  const schema = runtimeValueSchema(declaration)
  return schema && declaration.default !== undefined
    ? parseRuntimeDefault(schema, declaration.default, path)
    : declaration.default
}

function buildRegistry(declarations: EnvRuntimeConfigOptions | undefined, path: string, prefix?: string | false): EnvRuntimeRegistry {
  if (typeof declarations === "undefined") {
    return {}
  }
  if (!isPlainRecord(declarations)) {
    throw invalidEnvDeclaration(path, `Invalid runtime declaration at ${path}. Use env(), a serializable static value, or a nested object.`)
  }
  return Object.fromEntries(Object.entries(declarations).map(([key, value]) => {
    const valuePath = `${path}.${key}`
    if (!isEnvVariableDeclaration(value)) {
      if (isRuntimeStaticValue(value)) {
        return [key, { kind: "literal", value }]
      }
      if (!isPlainRecord(value)) {
        throw invalidEnvDeclaration(valuePath, `Invalid runtime declaration at ${valuePath}. Use env(), a serializable static value, or a nested object.`)
      }
      return [key, buildRegistry(value as EnvRuntimeConfigOptions, valuePath, canonicalKey.test(key) ? prefix : false)]
    }
    if (value.mode !== "runtime") {
      throw invalidEnvDeclaration(valuePath, `Runtime declaration ${valuePath} must use mode: "runtime".`)
    }
    const source = resolveEnvSource(value, valuePath, canonicalKey.test(key) ? prefix : false)
    if (source.kind !== "env" && source.kind !== "provider") {
      throw invalidEnvDeclaration(valuePath, `Runtime declaration ${valuePath} must use env.source() or env.provider().`)
    }
    const schema = runtimeValueSchema(value)
    if (!schema) {
      throw invalidEnvDeclaration(valuePath, `Runtime declaration ${valuePath} uses a custom schema. Server Env accepts env(), env.boolean(), env.number(), and env.enum() because runtime parsers must be serializable.`)
    }
    if (schema.kind === "enum" && value.secret) {
      throw invalidEnvDeclaration(valuePath, `Runtime declaration ${valuePath} cannot be a secret enum: generated types, the Console, and errors show its allowed values. Use env({ secret: true }) and check the value in server code.`)
    }
    const type = envValueTypeName(schema)
    if (value.type && value.type !== type) {
      throw invalidEnvDeclaration(valuePath, `Runtime declaration ${valuePath} uses type ${JSON.stringify(value.type)}, but its parser produces ${type}. Use env.boolean(), env.number(), or env.enum() to parse other types.`)
    }
    return [key, {
      default: typeof value.default === "undefined"
        ? undefined
        : parseRuntimeDefault(schema, value.default, valuePath),
      required: value.required,
      schema,
      secret: value.secret,
      source,
    }]
  }))
}

// Defaults use the parsed type. Only host and provider values are parsed from strings.
function parseRuntimeDefault(schema: EnvValueSchema, value: unknown, path: string): unknown {
  const typed = schema.kind === "boolean" || schema.kind === "number" ? hasRuntimeType(value, schema.kind) : true
  const result = typed ? parseEnvValue(schema, value) : { message: `Expected a ${schema.kind} default.`, success: false as const }
  if (!result.success) {
    throw envErrorDiagnostics.ENV_R0023({ message: `[vitehub] Invalid default for ${path}: ${result.message}` })
  }
  return result.data
}

/** The default prefix of canonical variable names. */
export const defaultEnvPrefix = "VITEHUB_"

/**
 * The canonical variable name of a declaration path: the prefix plus the path in upper snake case.
 * `env.server.cliproxy.apiKey` becomes `VITEHUB_CLIPROXY_API_KEY`. `false` disables canonical names.
 */
export function canonicalEnvName(path: string, prefix: string | false = defaultEnvPrefix): string | undefined {
  return prefix === false ? undefined : `${prefix}${pathToEnvName(path)}`
}

/**
 * Resolve the source of a declaration. An env source reads the canonical name first, then its
 * conventional names: the explicit `env.source()` names, or the unprefixed path name.
 */
export function resolveEnvSource(declaration: EnvVariableDeclaration, path: string, prefix: string | false = defaultEnvPrefix): EnvSource {
  const source = declaration.source ?? inferEnvSource(path)
  const canonical = canonicalEnvName(path, prefix)
  if (source.kind !== "env" || canonical === undefined || source.canonical === false) return source
  const names = [...new Set([canonical, ...(source.names ?? [source.name])])]
  return names.length === 1
    ? { ...source, canonical }
    : { ...source, canonical, label: `env:${names.join("|")}`, names }
}

function inferTypeName(value: unknown): string {
  if (Array.isArray(value)) {
    return "unknown[]"
  }
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return typeof value
    case "object":
      return value === null ? "null" : "Record<string, unknown>"
    case "undefined":
      return "undefined"
    default:
      return "unknown"
  }
}

async function resolveSourceValue(source: EnvSource, context: EnvSourceContext): Promise<{ label: string, value: unknown }> {
  switch (source.kind) {
    case "custom":
      return { label: source.label, value: await source.resolver(context) }
    case "env":
      for (const name of source.names || [source.name]) {
        const value = context.env[name]
        if (typeof value !== "undefined" && !(source.skipEmpty && value === "")) {
          return { label: `env:${name}`, value }
        }
      }
      return { label: source.label, value: undefined }
    case "git-branch":
      return { label: source.label, value: await resolveBuiltInSource(source.label, () => context.git.branch()) }
    case "git-commit":
      return { label: source.label, value: await resolveBuiltInSource(source.label, () => context.git.commit({ short: source.short })) }
    case "git-ref":
      return { label: source.label, value: await resolveBuiltInSource(source.label, () => context.git.ref()) }
    case "git-sha":
      return { label: source.label, value: await resolveBuiltInSource(source.label, () => context.git.sha({ short: source.short })) }
    case "git-tag":
      return { label: source.label, value: await resolveBuiltInSource(source.label, () => context.git.tag()) }
    case "build-timestamp":
      return { label: source.label, value: context.build.timestamp() }
    case "package-json":
      return { label: source.label, value: readPath(await resolveBuiltInSource(source.label, () => context.packageJson()), source.path) }
    case "provider":
      throw invalidEnvDeclaration("env", "env.provider() is available only to Server Env at runtime.")
  }
}

async function resolveBuiltInSource<T>(source: string, resolveSource: () => T | Promise<T>): Promise<T> {
  try {
    return await resolveSource()
  }
  catch (cause) {
    if (isAbortError(cause) || isViteHubError(cause)) throw cause
    throw envSourceFailed(source, cause)
  }
}

function validateBuildDeclarations(declarations: EnvBuildConfigOptions | undefined, path: string): void {
  if (typeof declarations === "undefined") return
  if (!isPlainRecord(declarations)) {
    throw invalidEnvDeclaration(path, `Invalid declaration at ${path}. Use env(), a serializable static value, or a nested object.`)
  }
  for (const [key, declaration] of Object.entries(declarations)) {
    const valuePath = `${path}.${key}`
    if (isEnvVariableDeclaration(declaration)) {
      if (declaration.mode !== "build") {
        throw invalidEnvDeclaration(valuePath, `${valuePath} must use mode: "build".`)
      }
      if (declaration.secret) {
        throw invalidEnvDeclaration(valuePath, `${valuePath} cannot be marked secret because Vite define values are bundled.`)
      }
      continue
    }
    if (isBuildStaticValue(declaration)) continue
    validateBuildDeclarations(declaration as EnvBuildConfigOptions, valuePath)
  }
}

function assertEnvVariableDeclaration(path: string, declaration: unknown): asserts declaration is EnvVariableDeclaration {
  if (!isEnvVariableDeclaration(declaration)) {
    throw invalidEnvDeclaration(path, `Invalid declaration at ${path}. Use env().`)
  }
}

function inferEnvSource(path: string): EnvSource {
  const name = pathToEnvName(path)
  return {
    kind: "env",
    label: `env:${name}`,
    name,
    serializable: true,
  }
}

function pathToEnvName(path: string): string {
  return path
    .split(".")
    .slice(1)
    .flatMap(segment => segmentToEnvParts(segment))
    .filter(Boolean)
    .join("_")
}

function segmentToEnvParts(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .split("_")
    .map(part => part.toUpperCase())
    .filter(Boolean)
}

function isEnvVariableDeclaration(value: unknown): value is EnvVariableDeclaration {
  return isPlainRecord(value) && value.kind === "env-variable"
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

function isRuntimeStaticValue(value: unknown): value is EnvRuntimeStaticValue {
  return isBuildStaticValue(value)
}

function isBuildStaticValue(value: unknown): value is EnvBuildStaticValue {
  if (value === null) {
    return true
  }
  switch (typeof value) {
    case "boolean":
    case "string":
      return true
    case "number":
      return Number.isFinite(value)
    case "object":
      if (!Array.isArray(value)) {
        return false
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isBuildStaticValue(value[index])) {
          return false
        }
      }
      return true
    default:
      return false
  }
}

async function readPackageJson(rootDir: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8"))
  if (!isPlainRecord(value)) {
    throw envErrorDiagnostics.ENV_R0012({ message: "package.json must contain an object." })
  }
  return value
}

async function gitOutput(rootDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: rootDir })
  return stdout.trim()
}

function readPath(value: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null) {
      return undefined
    }
    return (current as Record<string, unknown>)[segment]
  }, value)
}
