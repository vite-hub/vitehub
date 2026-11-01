import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, relative } from "node:path"

import { glob } from "tinyglobby"

import packageJson from "../../package.json" with { type: "json" }
import { findProperty, keyName, line, parseProgram, walk } from "../ast.ts"
import { CodemodError } from "../types.ts"
import { rewriteCallSites } from "./call-sites.ts"
import { editNuxtConfig } from "./config-edit.ts"
import { planFromEnvFile, readEnvFileKeys } from "./env-file.ts"
import { pathLabel } from "./fields.ts"
import { findModuleEntry, loadNuxtConfig, loadSchemaModule, moduleName, readNuxtConfig, readRuntimeConfig, readStaticOptions } from "./nuxt-config.ts"
import { editPackageJson } from "./package-json.ts"
import { planFromJsonSchema, schemaIssues, schemaToJsonSchema } from "./schema.ts"

import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"
import type { EnvSource } from "./config-edit.ts"
import type { EnvField, PlannedFollowUp } from "./fields.ts"
import type { NuxtConfigFile, StaticOptions } from "./nuxt-config.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

interface ResolvedOptions {
  envSchema?: { file: string, paths: Record<string, string> }
  schemaPath?: string
  schema?: unknown
}

function mergeStatic(top: StaticOptions, inline: StaticOptions): StaticOptions {
  return {
    envSchema: inline.envSchema ?? top.envSchema,
    schemaPath: inline.schemaPath ?? (inline.inlineSchema ? undefined : top.schemaPath),
    inlineSchema: inline.inlineSchema || (!inline.schemaPath && top.inlineSchema),
    dynamic: inline.dynamic || top.dynamic,
  }
}

function evaluatedEnvSchema(value: unknown): ResolvedOptions["envSchema"] {
  if (typeof value === "string") return { file: value, paths: {} }
  if (!isRecord(value) || typeof value.file !== "string") return undefined
  const paths = isRecord(value.paths) ? Object.fromEntries(Object.entries(value.paths).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {}
  return { file: value.file, paths }
}

/** Reads the module options statically, and runs nuxt.config only when an inline schema or a dynamic option needs it. */
async function resolveOptions(config: NuxtConfigFile, staticOptions: StaticOptions): Promise<ResolvedOptions> {
  if (!staticOptions.inlineSchema && !staticOptions.dynamic) {
    return { envSchema: staticOptions.envSchema, schemaPath: staticOptions.schemaPath }
  }
  const evaluated = await loadNuxtConfig(config.path)
  const modules = Array.isArray(evaluated.modules) ? evaluated.modules : []
  const tuple = modules.find((entry): entry is unknown[] => Array.isArray(entry) && entry[0] === moduleName)
  const options = {
    ...(isRecord(evaluated.safeRuntimeConfig) ? evaluated.safeRuntimeConfig : {}),
    ...(tuple && isRecord(tuple[1]) ? tuple[1] : {}),
  }
  const schema = options.$schema
  return {
    envSchema: evaluatedEnvSchema(options.envSchema) ?? staticOptions.envSchema,
    schemaPath: typeof schema === "string" ? schema : undefined,
    schema: typeof schema === "string" ? undefined : schema,
  }
}

/** Line of each object property in a schema module, by its dotted path of property keys. */
function schemaLines(code: string): Map<string, number> {
  const lines = new Map<string, number>()
  let program: ReturnType<typeof parseProgram>
  try {
    program = parseProgram(code)
  }
  catch {
    return lines
  }
  walk(program, (node, ancestors) => {
    if (node.type !== "ObjectProperty") return
    const key = keyName(node.key, node.computed)
    if (!key) return
    const path = [...ancestors.flatMap(ancestor => ancestor.type === "ObjectProperty" ? [keyName(ancestor.key, ancestor.computed) ?? ""] : []), key].join(".")
    if (!lines.has(path)) lines.set(path, line(node))
  })
  return lines
}

async function findEslintReferences(cwd: string): Promise<FollowUp[]> {
  const files = await glob(["eslint.config.{js,mjs,cjs,ts,mts,cts}", ".eslintrc", ".eslintrc.{js,cjs,json,yml,yaml}"], { cwd, dot: true })
  const followUps: FollowUp[] = []
  for (const file of files.sort()) {
    const lines = (await readFile(join(cwd, file), "utf8")).split("\n")
    lines.forEach((text, index) => {
      if (/nuxt-safe-runtime-config\/eslint|safe-runtime-config\/prefer-safe-runtime-config/.test(text)) {
        followUps.push({ file, line: index + 1, message: "Remove the nuxt-safe-runtime-config ESLint rule. Its prefer-safe-runtime-config rule has no Env equivalent." })
      }
    })
  }
  return followUps
}

async function findOutOfScopeConfigs(cwd: string, rootConfig: string): Promise<FollowUp[]> {
  const files = await glob(["**/nuxt.config.{ts,mts,js,mjs,cjs}", "**/nitro.config.{ts,mts,js,mjs,cjs}"], { cwd, ignore: ["**/node_modules/**", "**/.nuxt/**", "**/.output/**"] })
  const followUps: FollowUp[] = []
  for (const file of files.sort()) {
    if (file === rootConfig) continue
    const text = await readFile(join(cwd, file), "utf8")
    if (text.includes("safeRuntimeConfig") || text.includes(moduleName)) {
      followUps.push({ file, message: `This config also uses ${moduleName}. The codemod migrates only the app nuxt.config. Migrate this file by hand, or run the codemod in its directory.` })
    }
  }
  return followUps
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const config = await readNuxtConfig(cwd)
  const moduleEntry = findModuleEntry(config)
  const safeProperty = findProperty(config.root, "safeRuntimeConfig")
  if (!moduleEntry && !safeProperty) {
    throw new CodemodError(`${config.fileName} does not use ${moduleName}: it has no "${moduleName}" module and no safeRuntimeConfig key.`)
  }
  const options = await resolveOptions(config, mergeStatic(readStaticOptions(safeProperty?.value), readStaticOptions(moduleEntry?.inlineOptions)))
  const hasSchema = options.schemaPath !== undefined || options.schema !== undefined
  if (options.envSchema && hasSchema) throw new CodemodError("safeRuntimeConfig sets both envSchema and $schema. The module accepts only one. Remove one, then run the codemod again.")
  if (!options.envSchema && !hasSchema) throw new CodemodError("safeRuntimeConfig has no envSchema and no $schema, so there is nothing to migrate. Remove the module by hand.")

  const planned: PlannedFollowUp[] = []
  const notes: string[] = []
  let fields: EnvField[]
  let unmigrated: string[] = []
  let env: EnvSource
  let schemaFile: string | undefined
  let lines = new Map<string, number>()
  let sourceLabel: string

  if (options.envSchema) {
    const file = options.envSchema.file
    const path = join(cwd, file)
    if (!existsSync(path)) throw new CodemodError(`Cannot find the envSchema file ${file}.`)
    const plan = planFromEnvFile(readEnvFileKeys(await readFile(path, "utf8")), options.envSchema.paths, file)
    fields = plan.fields
    planned.push(...plan.followUps)
    env = { kind: "env-schema", file, paths: plan.paths }
    sourceLabel = `envSchema (${file})`
    notes.push(`envSchema() with prefix "NUXT_" reads the same variable names: NUXT_PUBLIC_* keys become Public Env and other NUXT_* keys become Server Env, with the same camelCase names. Each field reads its exact schema key.`)
  }
  else {
    let schema = options.schema
    if (options.schemaPath !== undefined) {
      schema = await loadSchemaModule(cwd, options.schemaPath)
      const candidates = ["", ".ts", ".mts", ".js", ".mjs"].map(extension => `${options.schemaPath}${extension}`)
      const found = candidates.find(candidate => existsSync(join(cwd, candidate)))
      if (found) {
        schemaFile = relative(cwd, join(cwd, found))
        lines = schemaLines(await readFile(join(cwd, found), "utf8"))
      }
    }
    const runtime = readRuntimeConfig(config)
    const runtimeProperty = findProperty(config.root, "runtimeConfig")
    if (runtimeProperty && !runtime.object) {
      planned.push({ message: "runtimeConfig is not an object literal, so the codemod kept its values and removed no keys. Move the migrated values to Env defaults by hand." })
    }
    const plan = planFromJsonSchema({ jsonSchema: await schemaToJsonSchema(schema), issues: schemaIssues(schema), runtimeConfig: runtime.values })
    fields = plan.fields
    unmigrated = plan.unmigrated
    planned.push(...plan.followUps)
    env = { kind: "fields", fields }
    sourceLabel = schemaFile ? `$schema (${schemaFile})` : "$schema"
    notes.push("Each declaration reads its NUXT_* name with env.source(). Env reads the canonical name VITEHUB_<PATH> first, for example VITEHUB_API_SECRET before NUXT_API_SECRET.")
    if (schemaFile) notes.push(`The codemod did not delete ${schemaFile}. Delete it, and its schema library if nothing else uses it.`)
  }

  const migrated = new Set(fields.map(field => pathLabel(field)))
  const edited = editNuxtConfig({ config, env, migrated })
  const calls = await rewriteCallSites({ cwd, fields, unmigrated })
  const packageResult = await editPackageJson(cwd, packageJson.version, { env: env.kind === "env-schema" })

  const envLine = (field: EnvField) => edited.lineOf(["vitehub", "env", field.section, ...field.envPath])
  const configFollowUps: FollowUp[] = planned.map(({ anchor, message }) => {
    if (anchor && "file" in anchor) return { file: anchor.file, line: anchor.line, message }
    if (anchor && "env" in anchor) return { file: config.fileName, line: envLine(anchor.env), message }
    if (anchor && "runtimeConfig" in anchor) {
      const path = anchor.runtimeConfig.split(".")
      const configLine = edited.lineOf(["runtimeConfig", ...path], { exact: true })
      if (configLine || !schemaFile) return { file: config.fileName, line: configLine, message }
      return { file: schemaFile, line: lines.get(anchor.runtimeConfig), message }
    }
    const label = anchor && "schema" in anchor ? anchor.schema : undefined
    if (schemaFile && label !== undefined) return { file: schemaFile, line: lines.get(label), message }
    return { file: config.fileName, line: edited.lineOf(["vitehub", "env"]), message }
  })
  if (edited.presetNote) configFollowUps.push({ file: config.fileName, line: edited.lineOf(["vitehub", "preset"]), message: edited.presetNote })

  const secretFollowUps: FollowUp[] = []
  for (const field of fields.filter(entry => entry.secret)) {
    const reads = calls.secretReads.filter(read => read.field === field)
    const accessor = `useServerEnv().${field.envPath.join(".")}`
    if (!reads.length) {
      secretFollowUps.push({ file: config.fileName, line: envLine(field), message: `${accessor} is secret, a SecretEnv<string>. No rewritten file reads it. Call .unseal() where code needs the raw value.` })
    }
    for (const read of reads) {
      secretFollowUps.push({ file: read.file, line: read.line, message: `${accessor} is secret, a SecretEnv<string>. Call .unseal() where this code needs the raw value.` })
    }
  }

  const eslint = await findEslintReferences(cwd)
  const outOfScope = await findOutOfScopeConfigs(cwd, config.fileName)

  const edits: FileEdit[] = [{ path: config.fileName, before: config.code, after: edited.code }]
  if (packageResult.edit) edits.push(packageResult.edit)
  edits.push(...calls.edits)

  for (const source of edited.removedImports.filter(entry => /^[@a-z]/i.test(entry) && !entry.startsWith("nuxt"))) {
    notes.push(`${config.fileName} no longer imports ${source}. Remove it from package.json if nothing else uses it.`)
  }
  const publicCount = fields.filter(field => field.section === "public").length
  notes.push(
    "Public Env values are fixed at build time. Nuxt applied NUXT_PUBLIC_* overrides when the server started; now set them when you build. Server Env values are read when the server runs.",
    "Shelve and the standalone Nitro module (nuxt-safe-runtime-config/nitro) are out of scope for this codemod.",
  )
  if (!eslint.length) notes.push("No ESLint config references nuxt-safe-runtime-config/eslint.")

  return {
    summary: `migrated ${fields.length} Env declaration${fields.length === 1 ? "" : "s"} (${publicCount} public, ${fields.length - publicCount} server) from ${sourceLabel} to vite-hub/nuxt.`,
    edits,
    followUps: [...configFollowUps, ...calls.followUps, ...secretFollowUps, ...eslint, ...outOfScope],
    notes,
    nextSteps: [
      `Run \`${packageResult.installCommand}\` to install ${env.kind === "env-schema" ? "vite-hub and @vite-hub/env" : "vite-hub"} and remove ${moduleName}.`,
      "Run `npx nuxi prepare` to generate the Env types, then type-check the app.",
    ],
  }
}

export const nuxtSafeRuntimeConfig: Codemod = {
  name: moduleName,
  description: "Move a Nuxt app from nuxt-safe-runtime-config to ViteHub Env through vite-hub/nuxt.",
  usage: "[dir]",
  run: migrate,
}
