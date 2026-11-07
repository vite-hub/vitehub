import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { findProperty, keyName, line, quoteString } from "@vite-hub/internal/ast"
import { snakeCase } from "scule"
import { glob } from "tinyglobby"

import packageJson from "../../package.json" with { type: "json" }
import { readRuntimeConfig } from "../nuxt-safe-runtime-config/nuxt-config.ts"
import { addViteHubOptions, bindingFree, ConfigEditor, createLineResolver, useViteHubModule } from "../shared/config-editor.ts"
import { detectNuxtModule, readDependencies } from "../shared/detect.ts"
import { findModuleEntry, literalValue, objectProperty, readNuxtConfig, unwrapExpression } from "../shared/nuxt-config.ts"
import { editPackageJson } from "../shared/package-json.ts"
import { CodemodError } from "../types.ts"
import { rewriteResendCallSites } from "./call-sites.ts"

import type { Node } from "@vite-hub/internal/ast"
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

function processEnvName(node: Node | undefined): string | undefined {
  const value = node ? unwrapExpression(node) : undefined
  if (value?.type !== "MemberExpression" || value.object.type !== "MemberExpression") return undefined
  if (value.object.object.type !== "Identifier" || value.object.object.name !== "process" || keyName(value.object.property) !== "env") return undefined
  return keyName(value.property, value.computed)
}

/** Files outside nuxt.config that read `runtimeConfig.resend`, which the module filled in. */
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

  // Module options: `resend: { apiKey }` at the root.
  const moduleOptions = findProperty(config.root, "resend")
  if (moduleOptions && !keepModule) {
    const apiKey = moduleOptions.value.type === "ObjectExpression" ? findProperty(moduleOptions.value, "apiKey") : undefined
    const fromEnv = processEnvName(apiKey?.value)
    if (fromEnv) names.push(fromEnv)
    const literal = apiKey ? literalValue(apiKey.value) : undefined
    if (typeof literal === "string" && literal) followUps.push({ file: config.fileName, line: line(moduleOptions), message: "nuxt.config held a literal Resend API key. It was removed. Set NUXT_RESEND_API_KEY where the app runs, and rotate the key if this file is public." })
    editor.removeItem(moduleOptions)
    removedRootProperties.add(moduleOptions)
  }

  // runtimeConfig.resend.apiKey, which the module also reads.
  const runtimeConfig = objectProperty(config.root, "runtimeConfig")
  const resendProperty = runtimeConfig ? findProperty(runtimeConfig, "resend") : undefined
  const readers = keepModule ? [] : await runtimeConfigReaders(cwd)
  // Code that checks runtimeConfig.resend.apiKey keeps working: declare the key that the module filled in.
  // NUXT_RESEND_API_KEY still sets it when the server starts.
  if (readers.length && !resendProperty) {
    const declaration = `resend: { apiKey: ${quoteString("", editor.style)} }`
    if (runtimeConfig) editor.insertProperties(runtimeConfig, [declaration], new Set())
    else rootEntries.push(`runtimeConfig: { ${declaration} }`)
  }
  if (runtimeConfig && resendProperty) {
    const value = readRuntimeConfig(config).values.get("resend.apiKey")
    if (value?.processEnv) names.push(value.processEnv.name)
    if (!readers.length && !keepModule) {
      const runtimeProperty = findProperty(config.root, "runtimeConfig")
      if (runtimeConfig.properties.length === 1 && runtimeProperty) {
        editor.removeItem(runtimeProperty)
        removedRootProperties.add(runtimeProperty)
      }
      else editor.removeItem(resendProperty)
    }
  }
  followUps.push(...readers)
  names.push(...calls.apiKeyVariables)
  // `new Resend(useRuntimeConfig().key)`: Nuxt fills `runtimeConfig.key` from NUXT_<KEY> and from the variable it names.
  const runtimeValues = readRuntimeConfig(config).values
  for (const key of calls.runtimeConfigKeys) {
    const value = runtimeValues.get(key)
    names.push(`NUXT_${snakeCase(key).toUpperCase()}`)
    if (value?.processEnv) names.push(value.processEnv.name)
  }
  const sources = [...new Set(names)]
  if (!sources.length) sources.push("RESEND_API_KEY")

  const style = editor.style
  const envName = existingEnvImport(config) ?? (bindingFree(config, "env") ? "env" : "viteHubEnv")
  const sourceList = sources.length === 1 ? quoteString(sources[0]!, style) : `[${sources.map(name => quoteString(name, style)).join(", ")}]`
  const { preset, presetNote } = addViteHubOptions(editor, config, {
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
  if (presetNote) followUps.unshift({ file: config.fileName, line: lineOf(["vitehub", "preset"]), message: presetNote })

  // Keep the resend package while any file still imports it.
  const rewritten = new Map(calls.edits.map(edit => [edit.path, edit.after ?? ""]))
  let resendImported = false
  for (const file of await glob(["**/*.{ts,mts,cts,js,mjs,cjs,vue}"], { cwd, ignore: ignored })) {
    const code = rewritten.get(file) ?? await readFile(join(cwd, file), "utf8")
    if (/from\s+["']resend["']/.test(code)) resendImported = true
  }
  const dependencies = await readDependencies(cwd)
  const remove = [...(keepModule ? [] : [moduleName]), ...(resendImported || keepModule ? [] : ["resend"])].filter(name => dependencies.has(name))
  const packageResult = await editPackageJson(cwd, packageJson.version, { remove, add: ["vite-hub"] })
  const edits: FileEdit[] = [{ path: config.fileName, before: config.code, after: configCode }, ...calls.edits]
  if (packageResult.edit) edits.push(packageResult.edit)

  return {
    summary: `moved ${calls.sends} emails.send() call${calls.sends === 1 ? "" : "s"} to email.send() with the ViteHub Resend driver${preset ? `, deployment preset "${preset}"` : ""}.`,
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
      if (/new\s+Resend\s*\(/.test(await readFile(join(cwd, file), "utf8"))) return { reason: `${file} creates a Resend client` }
    }
    return undefined
  },
  run: migrate,
}
