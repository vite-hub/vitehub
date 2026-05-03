import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { parseSchema } from "../schema.ts"
import { RuntimeConfigError, assertNever } from "./errors.ts"

import type {
  ResolvedRuntimeConfigEntry,
  RuntimeConfigBuildDeclaration,
  RuntimeConfigDiagnosticEntry,
  RuntimeConfigOptions,
  RuntimeConfigRegistry,
  RuntimeConfigRuntimeDeclaration,
} from "../types.ts"

export function validateRuntimeConfigShape(config: RuntimeConfigOptions | undefined, target: "nitro" | "vite"): void {
  if (!config) {
    return
  }

  if (target === "vite" && config.runtime) {
    throw new RuntimeConfigError("`runtime.*` is not available in a Vite-only runtime-config block. Move it to `nitro.config.ts` or configure an explicit runtime transport.")
  }

  for (const [section, declarations] of Object.entries(config.build?.public || {})) {
    if (declarations.kind !== "build-env" && declarations.kind !== "define-literal" && declarations.kind !== "package-value") {
      throw new RuntimeConfigError(`Invalid declaration at build.public.${section}. Use rc.build.* declarations.`)
    }
  }

  for (const [section, declarations] of Object.entries(config.runtime?.server || {})) {
    if (declarations.kind === "runtime-secret" || declarations.kind === "runtime-env") {
      continue
    }
    throw new RuntimeConfigError(`Invalid declaration at runtime.server.${section}. Use rc.runtime.env() or rc.runtime.secret().`)
  }

  for (const [section, declarations] of Object.entries(config.runtime?.cloudflare?.bindings || {})) {
    if (declarations.kind !== "cloudflare-binding") {
      throw new RuntimeConfigError(`Invalid declaration at runtime.cloudflare.bindings.${section}. Use rc.cloudflare.binding.*().`)
    }
  }
}

export function resolveBuildEntries(
  declarations: Record<string, RuntimeConfigBuildDeclaration> | undefined,
  input: { env: Record<string, string | undefined>, packageRoot: string, section: "build.define" | "build.public" },
): { diagnostics: RuntimeConfigDiagnosticEntry[], entries: ResolvedRuntimeConfigEntry[] } {
  const entries: ResolvedRuntimeConfigEntry[] = []
  const diagnostics: RuntimeConfigDiagnosticEntry[] = []

  for (const [key, declaration] of Object.entries(declarations || {})) {
    const resolved = resolveBuildDeclaration(key, declaration, input)
    entries.push(resolved.entry)
    diagnostics.push(resolved.diagnostic)
  }

  return { diagnostics, entries }
}

export function resolveRuntimeEntries(
  declarations: Record<string, RuntimeConfigRuntimeDeclaration> | undefined,
  env: Record<string, string | undefined>,
  section: "runtime.public" | "runtime.server",
): { diagnostics: RuntimeConfigDiagnosticEntry[], entries: ResolvedRuntimeConfigEntry[] } {
  const entries: ResolvedRuntimeConfigEntry[] = []
  const diagnostics: RuntimeConfigDiagnosticEntry[] = []

  for (const [key, declaration] of Object.entries(declarations || {})) {
    const raw = env[declaration.envName] ?? declaration.default
    if (typeof raw === "undefined") {
      throw new RuntimeConfigError(`Missing ${section}.${key} from ${declaration.envName}.`)
    }
    const value = parseSchema(declaration.schema, raw, `${section}.${key}`)
    const defaulted = typeof env[declaration.envName] === "undefined"
    entries.push({
      key,
      masked: declaration.kind === "runtime-secret",
      source: `process.env.${declaration.envName}`,
      type: declaration.type ?? inferTypeName(value),
      value,
    })
    diagnostics.push({
      exposed: declaration.kind === "runtime-secret" ? "server only, masked" : section === "runtime.public" ? "public runtime transport" : "server only",
      key: `${section}.${key}`,
      masked: declaration.kind === "runtime-secret",
      source: defaulted ? "default" : `process.env.${declaration.envName}`,
      status: defaulted ? "defaulted" : "valid",
      timing: "Nitro startup or function execution",
      type: declaration.type ?? inferTypeName(value),
    })
  }

  return { diagnostics, entries }
}

export function createRuntimeRegistry(config: RuntimeConfigOptions | undefined): RuntimeConfigRegistry {
  return {
    cloudflare: config?.runtime?.cloudflare,
    public: config?.runtime?.public,
    server: config?.runtime?.server,
  }
}

export function inferTypeName(value: unknown): string {
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

function resolveBuildDeclaration(
  key: string,
  declaration: RuntimeConfigBuildDeclaration,
  input: { env: Record<string, string | undefined>, packageRoot: string, section: "build.define" | "build.public" },
): { diagnostic: RuntimeConfigDiagnosticEntry, entry: ResolvedRuntimeConfigEntry } {
  switch (declaration.kind) {
    case "build-env": {
      const raw = input.env[declaration.envName] ?? declaration.default
      if (typeof raw === "undefined") {
        throw new RuntimeConfigError(`Missing ${input.section}.${key} from ${declaration.envName}.`)
      }
      const value = parseSchema(declaration.schema, raw, `${input.section}.${key}`)
      const defaulted = typeof input.env[declaration.envName] === "undefined"
      return {
        diagnostic: {
          exposed: input.section === "build.define" ? "compile-time replacement" : "client bundle",
          key: `${input.section}.${key}`,
          masked: false,
          source: defaulted ? "default" : `.env/process:${declaration.envName}`,
          status: defaulted ? "defaulted" : "valid",
          timing: input.section === "build.define" ? "Vite transform/build" : "Vite config/dev/build",
          type: declaration.type ?? inferTypeName(value),
        },
        entry: {
          key,
          masked: false,
          source: declaration.envName,
          type: declaration.type ?? inferTypeName(value),
          value,
        },
      }
    }
    case "define-literal": {
      const value = parseSchema(declaration.schema, declaration.value, `${input.section}.${key}`)
      return {
        diagnostic: {
          exposed: "compile-time replacement",
          key: `${input.section}.${key}`,
          masked: false,
          source: "inline define value",
          status: "valid",
          timing: "Vite transform/build",
          type: declaration.type ?? inferTypeName(value),
        },
        entry: {
          key,
          masked: false,
          source: "inline",
          type: declaration.type ?? inferTypeName(value),
          value,
        },
      }
    }
    case "package-value": {
      const packageJson = JSON.parse(readFileSync(resolve(input.packageRoot, "package.json"), "utf8")) as Record<string, unknown>
      const value = parseSchema(declaration.schema, packageJson[declaration.key], `${input.section}.${key}`)
      return {
        diagnostic: {
          exposed: "compile-time replacement",
          key: `${input.section}.${key}`,
          masked: false,
          source: `package.json:${declaration.key}`,
          status: "valid",
          timing: "Vite transform/build",
          type: declaration.type ?? inferTypeName(value),
        },
        entry: {
          key,
          masked: false,
          source: `package.json:${declaration.key}`,
          type: declaration.type ?? inferTypeName(value),
          value,
        },
      }
    }
    default:
      return assertNever(declaration)
  }
}
