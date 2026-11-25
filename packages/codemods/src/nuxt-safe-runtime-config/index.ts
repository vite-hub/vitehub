import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { isAbsolute, join, posix, relative, resolve } from "node:path"

import { detectStyle, findProperty, keyName, line, parseProgram, walk } from "@vite-hub/internal/ast"
import { isRecord } from "@vite-hub/internal/object"
import { subset, validRange } from "semver"
import { glob } from "tinyglobby"

import packageJson from "../../package.json" with { type: "json" }
import { ConfigEditor, removeModuleEntry } from "../shared/config-editor.ts"
import { detectNuxtModule, readDependencies } from "../shared/detect.ts"
import { findModuleEntry, literalValue, loadNuxtConfig, readNuxtConfig } from "../shared/nuxt-config.ts"
import { editPackageJson } from "../shared/package-json.ts"
import { codemodError } from "../error-diagnostics.ts"
import { rewriteCallSites } from "./call-sites.ts"
import { editNuxtConfig } from "./config-edit.ts"
import { planFromEnvFile, readEnvFileKeys } from "./env-file.ts"
import { pathLabel } from "./fields.ts"
import { assertNotNitro2 } from "./nitro-config.ts"
import { loadSchemaModule, moduleName, readRuntimeConfig, readStaticOptions } from "./nuxt-config.ts"
import { planFromJsonSchema, schemaIssues, schemaToJsonSchema } from "./schema.ts"
import { planSchemaModule, renderSchemaModule } from "./schema-module.ts"

import type { ObjectProperty } from "@babel/types"
import type { NuxtConfigFile } from "../shared/nuxt-config.ts"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"
import type { EnvSource, SchemaModuleReference } from "./config-edit.ts"
import type { EnvField, PlannedFollowUp } from "./fields.ts"
import type { StaticOptions } from "./nuxt-config.ts"

interface ResolvedOptions extends Pick<StaticOptions, "onError" | "validateAtBuild" | "validateAtRuntime"> {
  envSchema?: { file: string, paths: Record<string, string> }
  schemaPath?: string
  schema?: unknown
}

function mergeStatic(top: StaticOptions, inline: StaticOptions): StaticOptions {
  return {
    envSchema: inline.envSchema ?? top.envSchema,
    schemaPath: inline.schemaPath ?? (inline.inlineSchema ? undefined : top.schemaPath),
    onError: inline.onError ?? top.onError,
    validateAtBuild: inline.validateAtBuild ?? top.validateAtBuild,
    validateAtRuntime: inline.validateAtRuntime ?? top.validateAtRuntime,
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

async function moduleVersion(cwd: string): Promise<string | undefined> {
  const installed = join(cwd, "node_modules", moduleName, "package.json")
  const manifest: unknown = existsSync(installed) ? parseJson(await readFile(installed, "utf8")) : undefined
  if (isRecord(manifest) && typeof manifest.version === "string") return manifest.version
  return (await readDependencies(cwd)).get(moduleName)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

function before040(version: string | undefined): boolean {
  return version !== undefined && validRange(version) !== null && subset(version, "<0.4.0")
}

function validationChecks(options: Pick<StaticOptions, "validateAtBuild" | "validateAtRuntime">, version: string | undefined): { validateAtBuild: boolean, validateAtRuntime: boolean } {
  if (before040(version)) {
    const validateAtRuntime = options.validateAtRuntime ?? false
    return { validateAtBuild: options.validateAtBuild ?? !validateAtRuntime, validateAtRuntime }
  }
  return { validateAtBuild: options.validateAtBuild !== false, validateAtRuntime: options.validateAtRuntime ?? true }
}

async function resolveOptions(config: NuxtConfigFile, staticOptions: StaticOptions): Promise<ResolvedOptions> {
  if (!staticOptions.inlineSchema && !staticOptions.dynamic) {
    return staticOptions
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
    onError: typeof options.onError === "string" ? options.onError : undefined,
    validateAtBuild: typeof options.validateAtBuild === "boolean" ? options.validateAtBuild : undefined,
    validateAtRuntime: typeof options.validateAtRuntime === "boolean" ? options.validateAtRuntime : undefined,
  }
}

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

async function layerExtends(config: NuxtConfigFile): Promise<string[]> {
  const property = findProperty(config.root, "extends")
  if (!property) return []
  const entries = property.value.type === "ArrayExpression" ? property.value.elements : [property.value]
  const values = entries.map(entry => entry?.type === "ArrayExpression" ? entry.elements[0] : entry).map(entry => entry ? literalValue(entry) : undefined)
  if (values.every((value): value is string => typeof value === "string")) return values
  const evaluated = (await loadNuxtConfig(config.path)).extends
  const layers = (Array.isArray(evaluated) ? evaluated : [evaluated]).map(entry => Array.isArray(entry) ? entry[0] : entry)
  if (layers.every((value): value is string => typeof value === "string")) return layers
  throw codemodError(`Cannot determine the layers extended by ${config.path}. Use static layer paths before migrating.`)
}

async function findOutOfScopeConfigs(cwd: string, rootConfig: NuxtConfigFile): Promise<{ directories: string[], followUps: FollowUp[] }> {
  const files = await glob(["**/nuxt.config.{ts,mts,js,mjs,cjs}", "**/nitro.config.{ts,mts,js,mjs,cjs}"], { cwd, ignore: ["**/node_modules/**", "**/.nuxt/**", "**/.output/**"] })
  const nuxtDirectories = new Set(files.filter(file => posix.basename(file).startsWith("nuxt.config.")).map(file => posix.dirname(file)))
  const layers = new Set([".", ...[...nuxtDirectories].filter(directory => posix.dirname(directory) === "layers")])
  const followUps: FollowUp[] = []
  for (const directory of layers) {
    const config = directory === "." ? rootConfig : await readNuxtConfig(join(cwd, directory))
    for (const layer of await layerExtends(config)) {
      if (!layer.startsWith(".") && !isAbsolute(layer)) continue
      const path = relative(cwd, resolve(cwd, directory, layer)).replaceAll("\\", "/")
      if (path === ".." || path.startsWith("../")) {
        followUps.push({ file: path, message: "This local layer is outside the app directory and was left unchanged. Migrate its useSafeRuntimeConfig() calls and nuxt-safe-runtime-config module options by hand before using the migrated app, which removes the original module and dependency." })
        continue
      }
      const layerDirectory = files.includes(path) ? posix.dirname(path) : path
      if (nuxtDirectories.has(layerDirectory)) layers.add(layerDirectory)
    }
  }
  const directories = new Set<string>()
  for (const file of files.sort()) {
    if (file === rootConfig.fileName) continue
    const directory = posix.dirname(file)
    const isLayer = directory !== "." && layers.has(directory)
    if (directory !== "." && !isLayer) directories.add(directory)
    const text = await readFile(join(cwd, file), "utf8")
    if (text.includes("safeRuntimeConfig") || text.includes(moduleName)) {
      followUps.push({ file, message: isLayer
        ? `This layer config also uses ${moduleName}. Its source was migrated with the app, but migrate this config's module options by hand.`
        : `This config also uses ${moduleName}. The codemod migrates only the app nuxt.config. Migrate this file by hand, or run the codemod in its directory.` })
    }
    else if (directory !== "." && !isLayer) {
      followUps.push({ file, message: "This config owns a separate source tree. The codemod left that tree unchanged; check its runtime config reads and migrate it separately if needed." })
    }
  }
  return { directories: [...directories], followUps }
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  await assertNotNitro2(cwd, moduleName)
  const config = await readNuxtConfig(cwd)
  const moduleEntry = findModuleEntry(config, moduleName)
  const safeProperty = findProperty(config.root, "safeRuntimeConfig")
  if (!moduleEntry && !safeProperty) {
    throw codemodError(`${config.fileName} does not use ${moduleName}: it has no "${moduleName}" module and no safeRuntimeConfig key.`)
  }
  const options = await resolveOptions(config, mergeStatic(readStaticOptions(safeProperty?.value), readStaticOptions(moduleEntry?.inlineOptions)))
  const hasSchema = options.schemaPath !== undefined || options.schema !== undefined
  if (options.envSchema && hasSchema) throw codemodError("safeRuntimeConfig sets both envSchema and $schema. The module accepts only one. Remove one, then run the codemod again.")
  if (!options.envSchema && !hasSchema) return removeUnusedModule(cwd, config, safeProperty)

  const planned: PlannedFollowUp[] = []
  const notes: string[] = []
  let fields: EnvField[]
  let unmigrated: string[] = []
  let env: EnvSource
  let schemaFile: string | undefined
  let lines = new Map<string, number>()
  let sourceLabel: string
  let schemaModule: SchemaModuleReference | undefined
  let generated: { path: string, code: string, importedSources: string[] } | undefined

  if (options.envSchema) {
    const file = options.envSchema.file
    const path = join(cwd, file)
    if (!existsSync(path)) throw codemodError(`Cannot find the envSchema file ${file}.`)
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
    const { validateAtBuild, validateAtRuntime } = validationChecks(options, await moduleVersion(cwd))
    const onError = options.onError ?? "throw"
    const enforced = onError === "throw" && (validateAtBuild || validateAtRuntime)
    const moduleTarget = enforced
      ? planSchemaModule({ cwd, config, schemaPath: options.schemaPath, options: [moduleEntry?.inlineOptions, safeProperty?.value] })
      : { reason: onError === "throw" ? "The module did not validate runtimeConfig, so the codemod wrote no schema module." : `The module only reported validation failures (onError: '${onError}'), but Env stops the app when a schema fails, so the codemod wrote no schema module.` }
    const target = "target" in moduleTarget ? moduleTarget.target : undefined
    const plan = await planFromJsonSchema({
      schema,
      schemaExports: Boolean(target),
      jsonSchema: await schemaToJsonSchema(schema, cwd),
      issues: schemaIssues(schema),
      runtimeConfig: runtime.values,
      validateAtBuild,
      validateAtRuntime,
      rejectInvalidDefaults: onError === "throw",
    })
    fields = plan.fields
    unmigrated = plan.unmigrated
    if ("reason" in moduleTarget && plan.needsSchemaModule) {
      const retry = enforced ? " Move the $schema to its own module, then run the codemod again." : ""
      planned.push({ message: `${moduleTarget.reason} The fields below that have rules keep follow-ups.${retry}`, anchor: { schema: "" } })
    }
    planned.push(...plan.followUps)
    env = { kind: "fields", fields }
    sourceLabel = schemaFile ? `$schema (${schemaFile})` : "$schema"
    notes.push("Each declaration reads its NUXT_* name with env.source(). Env reads the canonical name VITEHUB_<PATH> first, for example VITEHUB_API_SECRET before NUXT_API_SECRET.")
    if (target && fields.some(field => field.schema)) {
      const rendered = renderSchemaModule(target, fields, detectStyle(config.code, config.program))
      schemaModule = { runtimePath: target.runtimePath, importPath: target.importPath, exports: rendered.exports }
      generated = { path: target.path, code: rendered.code, importedSources: rendered.importedSources }
      notes.push(`${target.path} exports the $schema of each field that has a rule or transform. Server Env runs it with env.schemaFrom() when the server reads the value. Public Env runs it during the build.`)
      if (schemaFile) notes.push(`${target.path} imports ${schemaFile}. Keep ${schemaFile} and its schema library.`)
    }
    else if (schemaFile) {
      notes.push(`The codemod did not delete ${schemaFile}. Delete it, and its schema library if nothing else uses it.`)
    }
  }

  const migrated = new Set(fields.map(field => pathLabel(field)))
  const edited = editNuxtConfig({ config, env, migrated, schemaModule })
  const outOfScope = await findOutOfScopeConfigs(cwd, config)
  const calls = await rewriteCallSites({ cwd, fields, unmigrated, excludedDirectories: outOfScope.directories })
  const packageResult = await editPackageJson(cwd, packageJson.version, {
    remove: [moduleName],
    add: env.kind === "fields" ? ["vite-hub"] : [],
    require: env.kind === "env-schema" ? { name: "vite-hub", range: ">=0.5.1 <1", feature: "vite-hub/env/vite" } : undefined,
  })

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
  if (edited.hostNote) configFollowUps.push({ file: config.fileName, line: edited.lineOf(["vitehub", "host"]), message: edited.hostNote })

  const secretFollowUps: FollowUp[] = []
  for (const field of fields.filter(entry => entry.secret)) {
    const reads = calls.secretReads.filter(read => read.field === field)
    const accessor = `useServerEnv().${field.envPath.join(".")}`
    if (!reads.length) {
      secretFollowUps.push({ file: config.fileName, line: envLine(field), message: `${accessor} is secret, a ${secretType(field)}. No rewritten file reads it. Call .unseal() where code needs the raw value.` })
    }
    for (const read of reads) {
      secretFollowUps.push({ file: read.file, line: read.line, message: `${accessor} is secret, a ${secretType(field)}. Call .unseal() where this code needs the raw value.` })
    }
  }

  const eslint = await findEslintReferences(cwd)

  const edits: FileEdit[] = [{ path: config.fileName, before: config.code, after: edited.code }]
  if (generated) edits.push({ path: generated.path, before: undefined, after: generated.code })
  if (packageResult.edit) edits.push(packageResult.edit)
  edits.push(...calls.edits)

  const moved = new Set(generated?.importedSources)
  for (const source of edited.removedImports.filter(entry => /^[@a-z]/i.test(entry) && !entry.startsWith("nuxt") && !moved.has(entry))) {
    notes.push(`${config.fileName} no longer imports ${source}. Remove it from package.json if nothing else uses it.`)
  }
  const publicCount = fields.filter(field => field.section === "public").length
  notes.push(
    "Public Env values are fixed at build time. Nuxt applied NUXT_PUBLIC_* overrides when the server started; now set them when you build. Server Env values are read when the server runs.",
    "The standalone Nitro module (nuxt-safe-runtime-config/nitro) is out of scope for this codemod.",
  )
  if (!eslint.length) notes.push("No ESLint config references nuxt-safe-runtime-config/eslint.")

  return {
    summary: `migrated ${fields.length} Env declaration${fields.length === 1 ? "" : "s"} (${publicCount} public, ${fields.length - publicCount} server) from ${sourceLabel} to vite-hub/nuxt.`,
    edits,
    requiresNitro3: true,
    followUps: [...configFollowUps, ...calls.followUps, ...secretFollowUps, ...eslint, ...outOfScope.followUps, ...packageResult.followUps],
    notes,
    nextSteps: [
      `Run \`${packageResult.installCommand}\` to install vite-hub and remove ${moduleName}.`,
      "Run `npx nuxi prepare` to generate the Env types, then type-check the app.",
    ],
  }
}

function secretType(field: EnvField): string {
  return field.schema ? "SecretEnv of the schema output" : "SecretEnv<string>"
}

async function removeUnusedModule(cwd: string, config: NuxtConfigFile, safeProperty: ObjectProperty | undefined): Promise<CodemodResult> {
  const editor = new ConfigEditor(config)
  removeModuleEntry(editor, config, moduleName)
  const layers = await glob(["layers/*"], { cwd, onlyDirectories: true })
  const inheritsConfig = config.root.properties.some(property => property.type === "SpreadElement"
    || (keyName(property.key, property.computed) === "extends"
      && !(property.type === "ObjectProperty" && property.value.type === "ArrayExpression" && property.value.elements.length === 0)))
  if (inheritsConfig || layers.length) {
    throw codemodError(`${config.fileName} uses layers or a root spread. Schema-free removal cannot verify inherited schemas or useSafeRuntimeConfig() calls. Review the layer options and calls, then remove ${moduleName} by hand or declare the schema in the app config and run the codemod again.`)
  }
  const sources = await glob(["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"], { cwd, ignore: ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", config.fileName] })
  for (const file of sources.sort()) {
    const lines = (await readFile(join(cwd, file), "utf8")).split("\n")
    const index = lines.findIndex(text => text.includes("useSafeRuntimeConfig"))
    if (index >= 0) {
      throw codemodError(`safeRuntimeConfig has no envSchema and no $schema, but ${file}:${index + 1} calls useSafeRuntimeConfig(). Add the schema, then run the codemod again, or replace the call with useRuntimeConfig() and remove the module by hand.`)
    }
  }
  if (safeProperty) editor.removeItem(safeProperty)
  editor.removeUnusedBindings()
  const packageResult = await editPackageJson(cwd, packageJson.version, { remove: [moduleName], add: [] })
  const edits: FileEdit[] = [{ path: config.fileName, before: config.code, after: editor.output.toString() }]
  if (packageResult.edit) edits.push(packageResult.edit)
  return {
    summary: `removed ${moduleName}: it had no envSchema and no $schema, so it validated nothing.`,
    edits,
    followUps: [],
    notes: ["To validate environment variables with ViteHub Env, declare them under vitehub.env. See https://vitehub.dev/docs/env."],
    nextSteps: [`Run \`${packageResult.installCommand}\` to remove ${moduleName}.`],
  }
}

export const nuxtSafeRuntimeConfig: Codemod = {
  name: moduleName,
  description: "Move a Nuxt app from nuxt-safe-runtime-config to ViteHub Env through vite-hub/nuxt.",
  usage: "[dir]",
  detect: ({ cwd }) => detectNuxtModule(cwd, moduleName, ["safeRuntimeConfig"]),
  run: migrate,
}
