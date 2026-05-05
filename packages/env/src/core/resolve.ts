import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"

import { parseSchema } from "../schema.ts"
import { defaultStringSchema, isDefaultStringEnvVariable } from "./declarations.ts"
import { EnvError } from "./errors.ts"

import type {
  EnvDiagnosticEntry,
  EnvMode,
  EnvNitroConfigOptions,
  EnvRuntimeRegistry,
  EnvSource,
  EnvSourceContext,
  EnvVariableDeclaration,
  EnvViteConfigOptions,
  ResolvedEnvEntry,
} from "../types.ts"

const execFileAsync = promisify(execFile)

export function validateEnvConfigShape(config: EnvNitroConfigOptions | EnvViteConfigOptions | undefined, target: "nitro" | "vite"): void {
  if (!config) {
    return
  }

  if (target === "nitro") {
    const nitroConfig = config as EnvNitroConfigOptions
    if ("server" in nitroConfig) {
      throw new EnvError("`env.server` is not available in Nitro env config. Put private runtime declarations directly under `env`.")
    }
    if ("define" in nitroConfig) {
      throw new EnvError("`env.define` is build-only and only available in Vite config.")
    }
    validateNitroDeclarations(nitroConfig, "env")
    return
  }

  const viteConfig = config as EnvViteConfigOptions
  for (const key of Object.keys(viteConfig)) {
    if (key !== "define" && key !== "public") {
      throw new EnvError(`Invalid declaration at env.${key}. Vite env config only supports env.public and env.define.`)
    }
  }

  for (const [key, declaration] of Object.entries(viteConfig.public || {})) {
    assertEnvVariableDeclaration(`env.public.${key}`, declaration)
    if (declaration.mode !== "build") {
      throw new EnvError(`env.public.${key} must use mode: "build" in Vite config. Runtime public config requires Nitro transport.`)
    }
    if (declaration.secret) {
      throw new EnvError(`env.public.${key} cannot be marked secret.`)
    }
  }

  for (const [key, declaration] of Object.entries(viteConfig.define || {})) {
    assertEnvVariableDeclaration(`env.define.${key}`, declaration)
    if (declaration.mode !== "build") {
      throw new EnvError(`env.define.${key} must use mode: "build".`)
    }
    if (declaration.secret) {
      throw new EnvError(`env.define.${key} cannot be marked secret because Vite define values are bundled.`)
    }
  }
}

export function createSourceContext(input: {
  env: Record<string, string | undefined>
  mode: EnvMode
  rootDir: string
}): EnvSourceContext {
  return {
    env: input.env,
    git: {
      branch: () => gitOutput(input.rootDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
      commit: options => gitOutput(input.rootDir, options?.short ? ["rev-parse", "--short", "HEAD"] : ["rev-parse", "HEAD"]),
    },
    mode: input.mode,
    packageJson: () => readPackageJson(input.rootDir),
    rootDir: input.rootDir,
  }
}

export async function resolveEnvEntries(
  declarations: Record<string, EnvVariableDeclaration> | undefined,
  input: {
    context: EnvSourceContext
    exposure: "build public" | "compile-time replacement" | "public runtime transport" | "server only"
    prefix?: string
    section: "env.define" | "env.public" | "env.server"
    timing: string
  },
): Promise<{ diagnostics: EnvDiagnosticEntry[], entries: ResolvedEnvEntry[] }> {
  const entries: ResolvedEnvEntry[] = []
  const diagnostics: EnvDiagnosticEntry[] = []

  for (const [key, declaration] of Object.entries(declarations || {})) {
    const source = resolveEnvSource(declaration, `${input.section}.${key}`, input.prefix)
    const raw = await resolveSourceValue(source, input.context)
    const defaulted = typeof raw === "undefined"
    const valueForSchema = defaulted ? declaration.default : raw
    if (typeof valueForSchema === "undefined") {
      if (declaration.required) {
        throw new EnvError(`Missing ${input.section}.${key} from ${source.label}.`)
      }
      entries.push({
        key,
        masked: declaration.secret,
        source: source.label,
        type: declaration.type ?? "undefined",
        value: undefined,
      })
      diagnostics.push({
        exposed: declaration.secret ? `${input.exposure}, masked` : input.exposure,
        key: `${input.section}.${key}`,
        masked: declaration.secret,
        mode: declaration.mode,
        source: source.label,
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
      source: source.label,
      type,
      value,
    })
    diagnostics.push({
      exposed: declaration.secret ? `${input.exposure}, masked` : input.exposure,
      key: `${input.section}.${key}`,
      masked: declaration.secret,
      mode: declaration.mode,
      source: defaulted ? "default" : source.label,
      status: defaulted ? "defaulted" : "valid",
      timing: input.timing,
      type,
    })
  }

  return { diagnostics, entries }
}

export function createRuntimeRegistry(declarations: EnvNitroConfigOptions | undefined, options: { prefix?: string } = {}): EnvRuntimeRegistry {
  return buildRegistry(declarations, "env", options.prefix)
}

function buildRegistry(declarations: EnvNitroConfigOptions | undefined, path: string, prefix?: string): EnvRuntimeRegistry {
  if (!declarations) {
    return {}
  }
  return Object.fromEntries(Object.entries(declarations).map(([key, value]) => {
    const valuePath = `${path}.${key}`
    if (!isEnvVariableDeclaration(value)) {
      return [key, buildRegistry(value as EnvNitroConfigOptions, valuePath, prefix)]
    }
    const source = resolveEnvSource(value, valuePath, prefix)
    if (source.kind !== "env") {
      throw new EnvError(`Runtime declaration ${valuePath} must use envSource.env() in v1.`)
    }
    if (!isDefaultStringEnvVariable(value)) {
      throw new EnvError(`Runtime declaration ${valuePath} uses a custom schema, but Nitro runtime schemas cannot be serialized in v1.`)
    }
    if (value.type && value.type !== "string") {
      throw new EnvError(`Runtime declaration ${valuePath} uses type ${JSON.stringify(value.type)}, but Nitro runtime values are strings in v1.`)
    }
    return [key, {
      default: typeof value.default === "undefined"
        ? undefined
        : parseSchema(defaultStringSchema, value.default, valuePath),
      required: value.required,
      schema: { kind: "string" },
      secret: value.secret,
      source,
      type: value.type,
    }]
  }))
}

export function resolveEnvSource(declaration: EnvVariableDeclaration, path: string, prefix = ""): EnvSource {
  return declaration.source ?? inferEnvSource(path, prefix)
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

async function resolveSourceValue(source: EnvSource, context: EnvSourceContext): Promise<unknown> {
  switch (source.kind) {
    case "custom":
      return await source.resolver(context)
    case "env":
      return context.env[source.name]
    case "git-branch":
      return await context.git.branch()
    case "git-commit":
      return await context.git.commit({ short: source.short })
    case "package-json":
      return readPath(await context.packageJson(), source.path)
  }
}

function validateNitroDeclarations(declarations: EnvNitroConfigOptions, path: string): void {
  for (const [key, value] of Object.entries(declarations)) {
    const valuePath = `${path}.${key}`
    if (path === "env" && key === "public") {
      if (!isPlainRecord(value) || isEnvVariableDeclaration(value)) {
        throw new EnvError("Invalid declaration at env.public. Use a nested object of public envVariable() declarations.")
      }
      validateNitroDeclarations(value as EnvNitroConfigOptions, valuePath)
      continue
    }
    if (isEnvVariableDeclaration(value)) {
      if (value.mode !== "runtime") {
        throw new EnvError(`${valuePath} must use runtime mode.`)
      }
      if (value.source && value.source.kind !== "env") {
        throw new EnvError(`${valuePath} must use an env source in runtime mode for v1. Custom, package, and git sources are build-only.`)
      }
      if (path === "env.public" || path.startsWith("env.public.")) {
        if (value.secret) {
          throw new EnvError(`${valuePath} cannot be marked secret because public runtime config is exposed to the client.`)
        }
      }
      continue
    }
    if (!isPlainRecord(value)) {
      throw new EnvError(`Invalid declaration at ${valuePath}. Use envVariable() or a nested object of envVariable() declarations.`)
    }
    validateNitroDeclarations(value as EnvNitroConfigOptions, valuePath)
  }
}

function assertEnvVariableDeclaration(path: string, declaration: unknown): asserts declaration is EnvVariableDeclaration {
  if (!isEnvVariableDeclaration(declaration)) {
    throw new EnvError(`Invalid declaration at ${path}. Use envVariable().`)
  }
}

function inferEnvSource(path: string, prefix: string): EnvSource {
  const name = `${prefix}${pathToEnvName(path)}`
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

export function isEnvVariableDeclaration(value: unknown): value is EnvVariableDeclaration {
  return isPlainRecord(value) && value.kind === "env-variable"
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readPackageJson(rootDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8")) as Record<string, unknown>
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
