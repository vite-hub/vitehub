import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { findProperty, keyName, line, quoteString } from "@vite-hub/internal/ast"
import { snakeCase } from "scule"
import { glob } from "tinyglobby"

import packageJson from "../../package.json" with { type: "json" }
import { readRuntimeConfig, readRuntimeConfigValue } from "../nuxt-safe-runtime-config/nuxt-config.ts"
import { addViteHubOptions, bindingFree, ConfigEditor, createLineResolver, useViteHubModule } from "../shared/config-editor.ts"
import { detectNuxtModule, readDependencies } from "../shared/detect.ts"
import { findModuleEntry, objectProperty, readNuxtConfig } from "../shared/nuxt-config.ts"
import { editPackageJson } from "../shared/package-json.ts"
import { CodemodError } from "../types.ts"
import { hasResendClient, rewriteResendCallSites } from "./call-sites.ts"

import type { Node } from "@vite-hub/internal/ast"
import type { RuntimeConfigValue } from "../nuxt-safe-runtime-config/nuxt-config.ts"
import type { NuxtConfigFile } from "../shared/nuxt-config.ts"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const moduleName = "nuxt-resend"
const ignored = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/dist/**"]

/** The local name of an `env` import from `vite-hub/env`, when an earlier codemod or the app added one. */
function existingEnvImport(config: NuxtConfigFile): string | undefined {
  for (const statement of config.program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "vite-hub/env") continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && keyName(specifier.imported) === "env") return specifier.local.name
    }
  }
  return undefined
}

/** Suggest cleanup for recognized readers. Preservation must not depend on this scan. */
async function runtimeConfigReaders(cwd: string): Promise<FollowUp[]> {
  const followUps: FollowUp[] = []
  for (const file of (await glob(["**/*.{ts,mts,js,mjs,vue}"], { cwd, ignore: [...ignored, "nuxt.config.*"] })).sort()) {
    const lines = (await readFile(join(cwd, file), "utf8")).split("\n")
    lines.forEach((text, index) => {
      if (/\.resend\b\??\.|\{\s*resend\s*[:,}]|resend:\s*\{\s*apiKey/.test(text) && !/useResend/.test(text)) {
        followUps.push({ file, line: index + 1, message: "This code reads runtimeConfig.resend. runtimeConfig.resend.apiKey stays in nuxt.config, and NUXT_RESEND_API_KEY still sets it, so the read keeps working. ViteHub Email reads the key itself; remove the read when nothing else needs it." })
      }
    })
  }
  return followUps
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const config = await readNuxtConfig(cwd)
  const calls = await rewriteResendCallSites(cwd)
  const usesModule = Boolean(findModuleEntry(config, moduleName)) || (await readDependencies(cwd)).has(moduleName)
  if (!calls.sends && !usesModule) throw new CodemodError("No server code calls emails.send() on a Resend client, so there is nothing to migrate.")

  if (!calls.sends && calls.useResendRemaining.length) {
    throw new CodemodError(`useResend() is used in ways the codemod does not rewrite (${calls.useResendRemaining.join(", ")}), so nothing was migrated. Replace those emails.send() calls with email.send() from vite-hub/email/server, then run the codemod again.`)
  }
  // nuxt-resend provides useResend(), so it stays while any call is left.
  const keepModule = calls.useResendRemaining.length > 0
  const editor = new ConfigEditor(config)
  const removedRootProperties = new Set<Node>()
  const rootEntries = useViteHubModule(editor, config, findModuleEntry(config, moduleName) && !keepModule ? moduleName : undefined)
  const followUps: FollowUp[] = []
  const names: string[] = usesModule ? ["NUXT_RESEND_API_KEY"] : []
  const reportedKeys = new Set<string>()
  // Every config credential uses the same classification: known Env source or manual follow-up.
  const recordApiKey = (value: RuntimeConfigValue | undefined, path: string): void => {
    if (!value || reportedKeys.has(path)) return
    reportedKeys.add(path)
    if (value.processEnv) names.push(value.processEnv.name)
    const literal = value.literal ?? value.processEnv?.fallback
    if (typeof literal === "string" && literal) followUps.push({ file: config.fileName, line: value.line, message: `nuxt.config held a literal Resend API key at ${path}. Move it to one of the generated Email Env sources before using the migrated sends, and rotate the key if this file is public.` })
    else if (value.expression) followUps.push({ file: config.fileName, line: value.line, message: `The Resend API key at ${path} could not be read statically. Declare that value as vitehub.email.options.apiKey by hand before using the migrated sends.` })
  }

  // Module options: `resend: { apiKey }` at the root.
  const moduleOptions = findProperty(config.root, "resend")
  if (moduleOptions && !keepModule) {
    const options = objectProperty(config.root, "resend")
    const apiKey = options ? findProperty(options, "apiKey") : moduleOptions
    if (apiKey) recordApiKey(readRuntimeConfigValue(config.code, apiKey), options ? "resend.apiKey" : "resend")
    editor.removeItem(moduleOptions)
    removedRootProperties.add(moduleOptions)
  }

  // runtimeConfig.resend.apiKey, which the module also reads.
  const runtimeConfig = objectProperty(config.root, "runtimeConfig")
  const runtimeProperty = findProperty(config.root, "runtimeConfig")
  const resendProperty = runtimeConfig ? findProperty(runtimeConfig, "resend") : undefined
  const readers = keepModule ? [] : await runtimeConfigReaders(cwd)
  // Keep existing runtimeConfig and always declare the module's key when removing it.
  // Readers can use whole objects, aliases, computed keys, or files this codemod cannot parse.
  if (usesModule && !keepModule) {
    const apiKey = `apiKey: ${quoteString("", editor.style)}`
    const resendConfig = runtimeConfig ? objectProperty(runtimeConfig, "resend") : undefined
    if (resendConfig) {
      if (!findProperty(resendConfig, "apiKey")) editor.insertProperties(resendConfig, [apiKey], new Set())
    }
    else if (runtimeConfig && !resendProperty) editor.insertProperties(runtimeConfig, [`resend: { ${apiKey} }`], new Set())
    else if (!runtimeProperty) rootEntries.push(`runtimeConfig: { resend: { ${apiKey} } }`)
    else followUps.push({ file: config.fileName, line: line(resendProperty ?? runtimeProperty), message: "runtimeConfig.resend could not be read statically. Keep runtimeConfig.resend.apiKey declared by hand after removing nuxt-resend so existing reads keep working." })
  }
  const runtimeValues = readRuntimeConfig(config).values
  recordApiKey(runtimeValues.get("resend.apiKey") ?? runtimeValues.get("resend"), "runtimeConfig.resend.apiKey")
  followUps.push(...readers)
  if (new Set(calls.apiKeySources).size > 1) {
    followUps.push({ message: "Resend clients use different API-key sources. ViteHub Email uses one credential: the first available source. Check that all clients use the same account before using the migrated sends. Keep clients with different credentials on the Resend SDK or configure them separately by hand." })
  }
  names.push(...calls.apiKeyVariables)
  // `new Resend(useRuntimeConfig().key)`: Nuxt fills `runtimeConfig.key` from NUXT_<KEY> and from the variable it names.
  for (const key of calls.runtimeConfigKeys) {
    names.push(`NUXT_${snakeCase(key).toUpperCase()}`)
    recordApiKey(runtimeValues.get(key), `runtimeConfig.${key}`)
  }
  const sources = [...new Set(names)]
  if (!sources.length) sources.push("RESEND_API_KEY")

  const style = editor.style
  const envName = existingEnvImport(config) ?? (bindingFree(config, "env") ? "env" : "viteHubEnv")
  const sourceList = sources.length === 1 ? quoteString(sources[0]!, style) : `[${sources.map(name => quoteString(name, style)).join(", ")}]`
  const { host, hostNote } = addViteHubOptions(editor, config, {
    options: [{
      key: "email",
      label: "the Email options",
      value: indent => [
        "{",
        `${indent}${style.indent}driver: ${quoteString("resend", style)},`,
        `${indent}${style.indent}options: { apiKey: ${envName}({ secret: true, source: ${envName}.source(${sourceList}) }) },`,
        `${indent}}`,
      ].join("\n"),
    }],
    rootEntries,
    removedRootProperties,
  })
  editor.removeUnusedBindings()
  if (!existingEnvImport(config)) editor.addImport(`import { ${envName === "env" ? "env" : "env as viteHubEnv"} } from ${quoteString("vite-hub/env", style)}${style.semicolons ? ";" : ""}`)
  const configCode = editor.output.toString()
  const lineOf = createLineResolver(configCode)
  if (hostNote) followUps.unshift({ file: config.fileName, line: lineOf(["vitehub", "host"]), message: hostNote })

  // Keep ESM, CommonJS, TypeScript import-equals, and dynamic package loads.
  const rewritten = new Map(calls.edits.map(edit => [edit.path, edit.after ?? ""]))
  let resendImported = false
  for (const file of await glob(["**/*.{ts,mts,cts,js,mjs,cjs,vue}"], { cwd, ignore: ignored })) {
    const code = rewritten.get(file) ?? await readFile(join(cwd, file), "utf8")
    if (/\b(?:from\s*|import\s*|(?:require|import)\s*\(\s*)["']resend["']/.test(code)) resendImported = true
  }
  const dependencies = await readDependencies(cwd)
  const remove = [...(keepModule ? [] : [moduleName]), ...(resendImported || keepModule ? [] : ["resend"])].filter(name => dependencies.has(name))
  const packageResult = await editPackageJson(cwd, packageJson.version, { remove, add: ["vite-hub"] })
  const edits: FileEdit[] = [{ path: config.fileName, before: config.code, after: configCode }, ...calls.edits]
  if (packageResult.edit) edits.push(packageResult.edit)

  return {
    summary: `moved ${calls.sends} emails.send() call${calls.sends === 1 ? "" : "s"} to email.send() with the ViteHub Resend driver${host ? `, host "${host}"` : ""}.`,
    edits,
    followUps: [...followUps, ...calls.followUps],
    notes: [
      `The API key is Secret Env read from ${sources.join(", then ")}. It resolves on each send, so builds do not need it.`,
      "In vite dev, email.send() stores messages in the development outbox instead of sending them. Set vitehub.email.remote to true to send real email in dev.",
      ...(resendImported ? ["Some files still import the resend package, so it stays in package.json."] : []),
      ...(keepModule ? [`${moduleName} stays because ${calls.useResendRemaining.join(", ")} still call useResend(). Remove it after those follow-ups.`] : []),
    ],
    nextSteps: [
      `Run \`${packageResult.installCommand}\` to install vite-hub${remove.length ? ` and remove ${remove.join(" and ")}` : ""}.`,
      "Run `npx nuxi prepare`, then type-check the app.",
    ],
  }
}

export const resend: Codemod = {
  name: "resend",
  description: "Move nuxt-resend and Resend SDK emails.send() calls to ViteHub Email through vite-hub/nuxt.",
  usage: "[dir]",
  detect: async ({ cwd }) => {
    const module = await detectNuxtModule(cwd, moduleName)
    if (module) return module
    if (!(await readDependencies(cwd)).has("resend")) return undefined
    for (const file of (await glob(["server/**/*.{ts,mts,js,mjs}"], { cwd, ignore: ignored })).sort()) {
      if (hasResendClient(file, await readFile(join(cwd, file), "utf8"))) return { reason: `${file} creates a Resend client` }
    }
    return undefined
  },
  run: migrate,
}
