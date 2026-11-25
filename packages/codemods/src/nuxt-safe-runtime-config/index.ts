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
import { findModuleEntry, literalValue, loadConfigFile, loadNuxtConfig, readNuxtConfig } from "../shared/nuxt-config.ts"
import { editPackageJson } from "../shared/package-json.ts"
import { codemodError, isCodemodError } from "../error-diagnostics.ts"
import { rewriteCallSites } from "./call-sites.ts"
import { editNuxtConfig } from "./config-edit.ts"
import { planFromEnvFile, readEnvFileKeys } from "./env-file.ts"
import { pathLabel } from "./fields.ts"
import { assertNotNitro2, editNitroConfig, findNitroModuleEntry, isNitroApp, nitroModuleName, planNitroHost, readNitroConfig, readVitePreset, writeViteConfig } from "./nitro-config.ts"
import { loadSchemaModule, moduleName, readRuntimeConfig, readStaticOptions } from "./nuxt-config.ts"
import { planFromJsonSchema, schemaIssues, schemaToJsonSchema } from "./schema.ts"
import { planSchemaModule, renderSchemaModule } from "./schema-module.ts"

import type { Node, ObjectProperty } from "@babel/types"
import type { NuxtConfigFile } from "../shared/nuxt-config.ts"
import type { Codemod, CodemodContext, CodemodResult, Detection, FileEdit, FollowUp } from "../types.ts"
import type { EnvSource, SchemaModuleReference } from "./config-edit.ts"
import type { EnvField, Framework, PlannedFollowUp } from "./fields.ts"
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

/** Reads the module options statically, and runs the config only when an inline schema or a dynamic option needs it. */
async function resolveOptions(staticOptions: StaticOptions, load: () => Promise<Record<string, unknown>>): Promise<ResolvedOptions> {
  if (!staticOptions.inlineSchema && !staticOptions.dynamic) {
    return staticOptions
  }
  const evaluated = await load()
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
  // Nuxt consumes immediate layers/ children automatically, and resolves each
  // configured local extends path relative to the config that declares it.
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

interface SchemaPlanResult {
  fields: EnvField[]
  unmigrated: string[]
  planned: PlannedFollowUp[]
  notes: string[]
  schemaFile?: string
  lines: Map<string, number>
  sourceLabel: string
  schemaModule?: SchemaModuleReference
  generated?: { path: string, code: string, importedSources: string[] }
  transforms: string[]
}

const reasonList = new Intl.ListFormat("en", { type: "conjunction" })

function routeReason(reasons: readonly string[], summary: string): string {
  if (!reasons.length) return summary
  return `moved here because ${reasonList.format(reasons)}. ${summary.charAt(0).toUpperCase()}${summary.slice(1)}`
}

function transformReason(transforms: readonly string[]): string[] {
  if (!transforms.length) return []
  return [`the schema has transforms on ${reasonList.format(transforms.map(path => path ? `\`${path}\`` : "the whole runtimeConfig"))}`]
}

async function planSchema(input: { cwd: string, config: NuxtConfigFile, options: ResolvedOptions, optionNodes: readonly (Node | undefined)[], framework: Framework }): Promise<SchemaPlanResult> {
  const { cwd, config, options, framework } = input
  const planned: PlannedFollowUp[] = []
  const notes: string[] = []
  let schemaFile: string | undefined
  let lines = new Map<string, number>()
  let schemaModule: SchemaModuleReference | undefined
  let generated: SchemaPlanResult["generated"]
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
    ? planSchemaModule({ cwd, config, schemaPath: options.schemaPath, options: input.optionNodes })
    : { reason: onError === "throw" ? "The module did not validate runtimeConfig, so the codemod wrote no schema module." : `The module only reported validation failures (onError: '${onError}'), but Env stops the app when a schema fails, so the codemod wrote no schema module.` }
  const target = "target" in moduleTarget ? moduleTarget.target : undefined
  const issues = schemaIssues(schema)
  const plan = await planFromJsonSchema({
    schema,
    schemaExports: Boolean(target),
    jsonSchema: await schemaToJsonSchema(schema, cwd),
    issues,
    runtimeConfig: runtime.values,
    validateAtBuild,
    validateAtRuntime,
    rejectInvalidDefaults: onError === "throw",
    framework,
  })
  const { fields, unmigrated } = plan
  if ("reason" in moduleTarget && plan.needsSchemaModule) {
    const retry = enforced ? " Move the $schema to its own module, then run the codemod again." : ""
    planned.push({ message: `${moduleTarget.reason} The fields below that have rules keep follow-ups.${retry}`, anchor: { schema: "" } })
  }
  planned.push(...plan.followUps)
  const sourceLabel = schemaFile ? `$schema (${schemaFile})` : "$schema"
  const prefix = framework === "nitro" ? "NITRO_" : "NUXT_"
  notes.push(`Each declaration reads its ${prefix}* name with env.source(). Env reads the canonical name VITEHUB_<PATH> first, for example VITEHUB_API_SECRET before ${prefix}API_SECRET.`)
  if (target && fields.some(field => field.schema)) {
    const rendered = renderSchemaModule(target, fields, detectStyle(config.code, config.program))
    schemaModule = { runtimePath: target.runtimePath, importPath: target.importPath, exports: rendered.exports }
    generated = { path: target.path, code: rendered.code, importedSources: rendered.importedSources }
    notes.push(`${target.path} exports the $schema of each field that has a rule or transform. Server Env runs it with env.schemaFrom() when the server reads the value.${framework === "nuxt" ? " Public Env runs it during the build." : ""}`)
    if (schemaFile) notes.push(`${target.path} imports ${schemaFile}. Keep ${schemaFile} and its schema library.`)
  }
  else if (schemaFile) {
    notes.push(`The codemod did not delete ${schemaFile}. Delete it, and its schema library if nothing else uses it.`)
  }
  return { fields, unmigrated, planned, notes, schemaFile, lines, sourceLabel, schemaModule, generated, transforms: [...issues.transforms] }
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  await assertNotNitro2(cwd, moduleName)
  if (await isNitroApp(cwd)) return migrateNitro(cwd)
  const config = await readNuxtConfig(cwd)
  const moduleEntry = findModuleEntry(config, moduleName)
  const safeProperty = findProperty(config.root, "safeRuntimeConfig")
  if (!moduleEntry && !safeProperty) {
    throw codemodError(`${config.fileName} does not use ${moduleName}: it has no "${moduleName}" module and no safeRuntimeConfig key.`)
  }
  const options = await resolveOptions(mergeStatic(readStaticOptions(safeProperty?.value), readStaticOptions(moduleEntry?.inlineOptions)), () => loadNuxtConfig(config.path))
  const hasSchema = options.schemaPath !== undefined || options.schema !== undefined
  if (options.envSchema && hasSchema) throw codemodError("safeRuntimeConfig sets both envSchema and $schema. The module accepts only one. Remove one, then run the codemod again.")
  if (!options.envSchema && !hasSchema) return removeUnusedModule(cwd, config, safeProperty)

  let schemaPlan: SchemaPlanResult
  let env: EnvSource
  if (options.envSchema) {
    const planned: PlannedFollowUp[] = []
    const file = options.envSchema.file
    const path = join(cwd, file)
    if (!existsSync(path)) throw codemodError(`Cannot find the envSchema file ${file}.`)
    const plan = planFromEnvFile(readEnvFileKeys(await readFile(path, "utf8")), options.envSchema.paths, file)
    planned.push(...plan.followUps)
    schemaPlan = {
      fields: plan.fields,
      unmigrated: [],
      planned,
      notes: [`envSchema() with prefix "NUXT_" reads the same variable names: NUXT_PUBLIC_* keys become Public Env and other NUXT_* keys become Server Env, with the same camelCase names. Each field reads its exact schema key.`],
      lines: new Map(),
      sourceLabel: `envSchema (${file})`,
      transforms: [],
    }
    env = { kind: "env-schema", file, paths: plan.paths }
  }
  else {
    schemaPlan = await planSchema({ cwd, config, options, optionNodes: [moduleEntry?.inlineOptions, safeProperty?.value], framework: "nuxt" })
    env = { kind: "fields", fields: schemaPlan.fields }
  }
  const { fields, unmigrated, planned, notes, schemaFile, lines, sourceLabel, schemaModule, generated, transforms } = schemaPlan
  const reasons = env.kind === "env-schema" ? [`the app validates with envSchema (\`${env.file}\`)`] : transformReason(transforms)

  const migrated = new Set(fields.map(field => pathLabel(field)))
  const edited = editNuxtConfig({ config, env, migrated, schemaModule })
  const outOfScope = await findOutOfScopeConfigs(cwd, config)
  const calls = await rewriteCallSites({ cwd, fields, unmigrated, excludedDirectories: outOfScope.directories })
  const packageResult = await editPackageJson(cwd, packageJson.version, { remove: [moduleName], add: env.kind === "env-schema" ? ["vite-hub", "@vite-hub/env"] : ["vite-hub"] })

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
  notes.push("Public Env values are fixed at build time. Nuxt applied NUXT_PUBLIC_* overrides when the server started; now set them when you build. Server Env values are read when the server runs.")
  if (!eslint.length) notes.push("No ESLint config references nuxt-safe-runtime-config/eslint.")

  return {
    summary: routeReason(reasons, `migrated ${fields.length} Env declaration${fields.length === 1 ? "" : "s"} (${publicCount} public, ${fields.length - publicCount} server) from ${sourceLabel} to vite-hub/nuxt.`),
    edits,
    followUps: [...configFollowUps, ...calls.followUps, ...secretFollowUps, ...eslint, ...outOfScope.followUps],
    notes,
    nextSteps: [
      `Run \`${packageResult.installCommand}\` to install ${env.kind === "env-schema" ? "vite-hub and @vite-hub/env" : "vite-hub"} and remove ${moduleName}.`,
      "Run `npx nuxi prepare` to generate the Env types, then type-check the app.",
    ],
  }
}

function secretType(field: EnvField): string {
  return field.schema ? "SecretEnv of the schema output" : "SecretEnv<string>"
}

/** Remove a schema-free module only when no layer can supply options or composable calls. */
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

const nitroScript = /\bnitro (dev|build)\b/g

async function findNitroOutOfScopeConfigs(cwd: string, rootConfig: NuxtConfigFile): Promise<{ directories: string[], followUps: FollowUp[] }> {
  const files = await glob(["**/nuxt.config.{ts,mts,js,mjs,cjs}", "**/nitro.config.{ts,mts,js,mjs,cjs}"], { cwd, ignore: ["**/node_modules/**", "**/.nitro/**", "**/.output/**"] })
  const directories = new Set<string>()
  const followUps: FollowUp[] = []
  for (const file of files.sort()) {
    if (file === rootConfig.fileName) continue
    const directory = posix.dirname(file)
    if (directory !== ".") directories.add(directory)
    const text = await readFile(join(cwd, file), "utf8")
    followUps.push({ file, message: text.includes("safeRuntimeConfig") || text.includes(moduleName)
      ? `This config also uses ${moduleName}. The codemod migrates only the app ${rootConfig.fileName}. Migrate this file by hand, or run the codemod in its directory.`
      : "This config owns a separate source tree. The codemod left that tree unchanged; check its runtime config reads and migrate it separately if needed." })
  }
  return { directories: [...directories], followUps }
}

async function migrateNitro(cwd: string): Promise<CodemodResult> {
  const config = await readNitroConfig(cwd)
  const moduleEntry = findNitroModuleEntry(config)
  const safeProperty = findProperty(config.root, "safeRuntimeConfig")
  if (!moduleEntry && !safeProperty) {
    throw codemodError(`${config.fileName} does not use ${nitroModuleName}: it has no "${nitroModuleName}" module and no safeRuntimeConfig key.`)
  }
  const options = await resolveOptions(readStaticOptions(safeProperty?.value), () => loadConfigFile(config.path, "defineNitroConfig"))
  if (options.envSchema) throw codemodError(`safeRuntimeConfig sets envSchema. The codemod migrates envSchema only in Nuxt apps. Move the fields to a $schema, then run the codemod again.`)
  if (options.schemaPath === undefined && options.schema === undefined) return removeUnusedNitroModule(cwd, config, moduleEntry)

  const { fields, unmigrated, planned, notes, schemaFile, lines, sourceLabel, schemaModule, generated, transforms } = await planSchema({ cwd, config, options, optionNodes: [safeProperty?.value], framework: "nitro" })
  const reasons = transformReason(transforms)
  if (moduleEntry) reasons.unshift(`${config.fileName} uses \`${nitroModuleName}\``)
  const migrated = new Set(fields.map(field => pathLabel(field)))
  const hostPlan = planNitroHost(config, await readVitePreset(cwd))
  const edited = editNitroConfig({ config, moduleEntry, migrated, preset: hostPlan.preset })
  const vite = await writeViteConfig({ cwd, nitroConfig: config, env: { kind: "fields", fields }, host: hostPlan.host, schemaModule, removePreset: hostPlan.removeVitePreset })
  const viteFile = vite.edit.path
  const outOfScope = await findNitroOutOfScopeConfigs(cwd, config)
  const calls = await rewriteCallSites({ cwd, fields, unmigrated, excludedDirectories: outOfScope.directories, framework: "nitro" })
  const packageResult = await editPackageJson(cwd, packageJson.version, {
    remove: [moduleName],
    add: ["vite-hub"],
    within: { vite: "^8.0.0" },
    scripts: command => command.replace(nitroScript, "vite $1"),
  })

  const envLine = (field: EnvField) => vite.lineOf(["env", field.section, ...field.envPath])
  const configFollowUps: FollowUp[] = planned.map(({ anchor, message }) => {
    if (anchor && "file" in anchor) return { file: anchor.file, line: anchor.line, message }
    if (anchor && "env" in anchor) return { file: viteFile, line: envLine(anchor.env), message }
    if (anchor && "runtimeConfig" in anchor) {
      const configLine = edited.lineOf(["runtimeConfig", ...anchor.runtimeConfig.split(".")], { exact: true })
      if (configLine || !schemaFile) return { file: config.fileName, line: configLine, message }
      return { file: schemaFile, line: lines.get(anchor.runtimeConfig), message }
    }
    const label = anchor && "schema" in anchor ? anchor.schema : undefined
    if (schemaFile && label !== undefined) return { file: schemaFile, line: lines.get(label), message }
    return { file: viteFile, line: vite.lineOf(["env"]), message }
  })
  if (hostPlan.note) configFollowUps.push({ file: viteFile, line: vite.lineOf(["host"]) ?? vite.lineOf(["env"]), message: hostPlan.note })

  const secretFollowUps: FollowUp[] = []
  for (const field of fields.filter(entry => entry.secret)) {
    const reads = calls.secretReads.filter(read => read.field === field)
    const accessor = `useServerEnv().${field.envPath.join(".")}`
    if (!reads.length) {
      secretFollowUps.push({ file: viteFile, line: envLine(field), message: `${accessor} is secret, a ${secretType(field)}. No rewritten file reads it. Call .unseal() where code needs the raw value.` })
    }
    for (const read of reads) {
      const message = read.unsealed
        ? `${accessor} is secret, a ${secretType(field)}. The codemod calls .unseal() here, so this code keeps the raw value. If the code only passes the value on, remove .unseal() to keep it sealed.`
        : `${accessor} is secret, a ${secretType(field)}. Call .unseal() where this code needs the raw value.`
      secretFollowUps.push({ file: read.file, line: read.line, message })
    }
  }

  const eslint = await findEslintReferences(cwd)
  const edits: FileEdit[] = [{ path: config.fileName, before: config.code, after: edited.code }, vite.edit]
  if (generated) edits.push({ path: generated.path, before: undefined, after: generated.code })
  if (packageResult.edit) edits.push(packageResult.edit)
  edits.push(...calls.edits)

  const moved = new Set(generated?.importedSources)
  for (const source of edited.removedImports.filter(entry => /^[@a-z]/i.test(entry) && !entry.startsWith("nitro") && entry !== nitroModuleName && !moved.has(entry))) {
    notes.push(`${config.fileName} no longer imports ${source}. Remove it from package.json if nothing else uses it.`)
  }
  notes.push(
    "Nitro also read runtimeConfig overrides with the \"_\" prefix and the NITRO_ENV_PREFIX prefix. Env reads only the names in env.source().",
    `Start and build the app with \`vite dev\` and \`vite build\`. \`nitro dev\` does not run Vite plugins, so it does not load vitehub(). The codemod changed the package.json scripts that ran \`nitro dev\` or \`nitro build\`.`,
    `nitro() from nitro/vite still reads ${config.fileName}, so the other Nitro options stay there.`,
  )
  if (!eslint.length) notes.push("No ESLint config references nuxt-safe-runtime-config/eslint.")

  return {
    summary: routeReason(reasons, `migrated ${fields.length} Env declaration${fields.length === 1 ? "" : "s"} (0 public, ${fields.length} server) from ${sourceLabel} to vitehub() in ${viteFile}.`),
    edits,
    followUps: [...configFollowUps, ...calls.followUps, ...secretFollowUps, ...eslint, ...outOfScope.followUps],
    notes,
    nextSteps: [
      `Run \`${packageResult.installCommand}\` to install vite-hub and vite, and remove ${moduleName}.`,
      "Run `npx vite build` to generate the Env types, then type-check the app.",
    ],
  }
}

async function removeUnusedNitroModule(cwd: string, config: NuxtConfigFile, moduleEntry: ReturnType<typeof findNitroModuleEntry>): Promise<CodemodResult> {
  const sources = await glob(["**/*.{ts,mts,cts,js,mjs,cjs}"], { cwd, ignore: ["**/node_modules/**", "**/.nitro/**", "**/.output/**", config.fileName] })
  for (const file of sources.sort()) {
    const lines = (await readFile(join(cwd, file), "utf8")).split("\n")
    const index = lines.findIndex(text => text.includes("useSafeRuntimeConfig"))
    if (index >= 0) {
      throw codemodError(`safeRuntimeConfig has no $schema, but ${file}:${index + 1} calls useSafeRuntimeConfig(). Add the schema, then run the codemod again, or replace the call with useRuntimeConfig() and remove the module by hand.`)
    }
  }
  const edited = editNitroConfig({ config, moduleEntry, migrated: new Set() })
  const packageResult = await editPackageJson(cwd, packageJson.version, { remove: [moduleName], add: [] })
  const edits: FileEdit[] = [{ path: config.fileName, before: config.code, after: edited.code }]
  if (packageResult.edit) edits.push(packageResult.edit)
  return {
    summary: `removed ${nitroModuleName}: it had no $schema, so it validated nothing.`,
    edits,
    followUps: [],
    notes: ["To validate environment variables with ViteHub Env, add vitehub({ env }) and nitro() to vite.config. See https://vitehub.dev/docs/env."],
    nextSteps: [`Run \`${packageResult.installCommand}\` to remove ${moduleName}.`],
  }
}

async function detect({ cwd }: CodemodContext): Promise<Detection | undefined> {
  if (await isNitroApp(cwd)) {
    try {
      const config = await readNitroConfig(cwd)
      if (findNitroModuleEntry(config)) return { reason: `${config.fileName} lists ${nitroModuleName} in modules` }
      if (findProperty(config.root, "safeRuntimeConfig")) return { reason: `${config.fileName} sets safeRuntimeConfig` }
    }
    catch (error) {
      if (!isCodemodError(error)) throw error
    }
  }
  return detectNuxtModule(cwd, moduleName, ["safeRuntimeConfig"])
}

export const nuxtSafeRuntimeConfig: Codemod = {
  name: moduleName,
  description: "Move a Nuxt or Nitro 3 app from nuxt-safe-runtime-config to ViteHub Env.",
  usage: "[dir]",
  detect,
  run: migrate,
}
