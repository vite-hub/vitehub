import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { keyName, line, parseProgram, quoteString, walk } from "@vite-hub/internal/ast"
import { glob } from "tinyglobby"

import packageJson from "../../package.json" with { type: "json" }
import { envExpression } from "../nuxt-safe-runtime-config/config-edit.ts"
import { addViteHubOptions, bindingFree, ConfigEditor, createLineResolver, useViteHubModule } from "../shared/config-editor.ts"
import { readDependencies } from "../shared/detect.ts"
import { readNuxtConfig } from "../shared/nuxt-config.ts"
import { editPackageJson } from "../shared/package-json.ts"
import { CodemodError } from "../types.ts"
import { classify, importsFile, localSpecifiersNaming, rewriteT3CallSites } from "./call-sites.ts"
import { loadT3EnvOptions } from "./load.ts"
import { planT3Env } from "./plan.ts"

import type { ImportDeclaration } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

export const packageName = "@t3-oss/env-nuxt"

const sourceGlobs = ["**/*.{ts,mts,cts,js,mjs,cjs,tsx,jsx}"]
const ignored = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/dist/**"]

/** Files that import `createEnv` from `@t3-oss/env-nuxt`. */
async function findEnvModules(cwd: string): Promise<string[]> {
  const files = await glob(sourceGlobs, { cwd, ignore: ignored })
  const found: string[] = []
  for (const file of files.sort()) {
    const source = await readFile(join(cwd, file), "utf8")
    if (/from\s+["']@t3-oss\/env-nuxt["']/.test(source)) found.push(file)
  }
  return found
}

/** Line of the `key:` property in the env module. */
function keyLines(code: string): Map<string, number> {
  const lines = new Map<string, number>()
  try {
    walk(parseProgram(code), (node) => {
      if (node.type !== "ObjectProperty") return
      const key = keyName(node.key, node.computed)
      if (key && !lines.has(key)) lines.set(key, line(node))
    })
  }
  catch {}
  return lines
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const modules = await findEnvModules(cwd)
  if (!modules.length) throw new CodemodError(`No file imports createEnv from ${packageName}, so there is nothing to migrate.`)
  if (modules.length > 1) throw new CodemodError(`More than one file calls createEnv(): ${modules.join(", ")}. The codemod migrates one env module. Merge them first, then run the codemod again.`)
  const envFile = modules[0]!
  const envCode = await readFile(join(cwd, envFile), "utf8")
  const lines = keyLines(envCode)
  const options = await loadT3EnvOptions(cwd, envFile)
  const plan = await planT3Env(options, cwd)
  if (!plan.fields.length) throw new CodemodError(`${envFile} declares no variable that Env can hold. Migrate it by hand.`)
  const fields = plan.fields.map(entry => entry.field)

  const config = await readNuxtConfig(cwd)
  const editor = new ConfigEditor(config)
  const rootEntries = useViteHubModule(editor, config)
  const configFollowUps: FollowUp[] = []
  // nuxt.config often imports the env module to validate it during the build. ViteHub checks Env itself.
  let configKeepsModule = false
  for (const statement of config.program.program.body) {
    if (statement.type !== "ImportDeclaration" || !importsFile(cwd, config.fileName, statement.source.value, envFile)) continue
    const declaration: ImportDeclaration = statement
    const used = declaration.specifiers.some((specifier) => {
      let referenced = false
      walk(config.program, (node, ancestors) => {
        if (node.type === "Identifier" && node.name === specifier.local.name && ancestors.at(-1) !== specifier && ancestors.at(-1)?.type !== "ImportSpecifier") referenced = true
      })
      return referenced
    })
    if (used) {
      configFollowUps.push({ file: config.fileName, line: line(declaration), message: `${config.fileName} reads values from ${envFile} while Nuxt loads the config. Read process.env here instead, then delete ${envFile}.` })
      configKeepsModule = true
    }
    else {
      editor.removeStatement(declaration)
    }
  }
  const envName = bindingFree(config, "env") ? "env" : "viteHubEnv"
  const style = editor.style
  const { host, hostNote } = addViteHubOptions(editor, config, {
    options: [{ key: "env", value: indent => envExpression({ kind: "fields", fields }, envName, indent, style), label: "the Env declarations" }],
    rootEntries,
    removedRootProperties: new Set<Node>(),
  })
  editor.removeUnusedBindings()
  editor.addImport(`import { ${envName === "env" ? "env" : "env as viteHubEnv"} } from ${quoteString("vite-hub/env", style)}${style.semicolons ? ";" : ""}`)
  const configCode = editor.output.toString()
  const lineOf = createLineResolver(configCode)
  if (hostNote) configFollowUps.push({ file: config.fileName, line: lineOf(["vitehub", "host"]), message: hostNote })

  const calls = await rewriteT3CallSites(cwd, { file: envFile, exportName: options.exportName }, plan.fields, [config.fileName])
  // Delete the env module only when no file, after the rewrite, still names it in an import.
  const rewritten = new Map(calls.edits.map(edit => [edit.path, edit.after ?? ""]))
  const unresolved: string[] = []
  for (const file of (await glob([...sourceGlobs, "**/*.vue"], { cwd, ignore: ignored })).sort()) {
    if (file === envFile || (file === config.fileName && configKeepsModule) || calls.remainingImporters.includes(file)) continue
    const code = file === config.fileName ? configCode : rewritten.get(file) ?? await readFile(join(cwd, file), "utf8")
    if (localSpecifiersNaming(code, envFile).length) unresolved.push(file)
  }
  for (const file of unresolved) {
    const action = classify(file) === "outside"
      ? "Read process.env here because this file runs outside the Nuxt app or server runtime."
      : "Rewrite them with useServerEnv() or usePublicEnv()."
    calls.followUps.push({ file, message: `This file imports a module named like ${envFile}, and the codemod could not tell whether it is ${envFile}. Its reads were not migrated, so ${envFile} stays. ${action}` })
  }
  const deleteModule = !calls.remainingImporters.length && !configKeepsModule && !unresolved.length
  const otherDependencies = await readDependencies(cwd)
  const packageResult = await editPackageJson(cwd, packageJson.version, { remove: deleteModule ? [packageName] : [], add: ["vite-hub"] })

  const edits: FileEdit[] = [{ path: config.fileName, before: config.code, after: configCode }, ...calls.edits]
  if (deleteModule) edits.push({ path: envFile, before: envCode, after: null })
  if (packageResult.edit) edits.push(packageResult.edit)

  const planFollowUps: FollowUp[] = plan.followUps.map(entry => ({
    file: deleteModule ? config.fileName : envFile,
    line: deleteModule ? lineOf(["vitehub", "env"]) : entry.key ? lines.get(entry.key) : undefined,
    message: entry.message,
  }))
  const notes = [
    "Each declaration reads its original variable with env.source(). Env reads the canonical name VITEHUB_<NAME> first, for example VITEHUB_DATABASE_URL before DATABASE_URL.",
    "Secret values are SecretEnv values. Where code needed the raw string, the codemod calls .unseal(). Pass the SecretEnv on instead where a library accepts it.",
    "Public Env values are fixed when you build. Set NUXT_PUBLIC_* variables for the build.",
  ]
  if (options.otherOptions.length) notes.push(`createEnv() options ${options.otherOptions.join(", ")} have no Env equivalent and were dropped.`)
  if (deleteModule) notes.push(`The codemod deleted ${envFile} and removed ${packageName}.${otherDependencies.has("zod") ? " Remove zod too if nothing else uses it." : ""}`)
  else notes.push(`${envFile} stays because code still imports it. Delete it and remove ${packageName} after the follow-ups.`)
  return {
    summary: `migrated ${fields.length} variable${fields.length === 1 ? "" : "s"} from ${envFile} to vite-hub/nuxt Env (${fields.filter(field => field.section === "public").length} public, ${fields.filter(field => field.section === "server").length} server)${host ? `, host "${host}"` : ""}.`,
    edits,
    followUps: [...configFollowUps, ...planFollowUps, ...calls.followUps],
    notes,
    nextSteps: [
      `Run \`${packageResult.installCommand}\` to install vite-hub${deleteModule ? ` and remove ${packageName}` : ""}.`,
      "Run `npx nuxi prepare` to generate the Env types, then type-check the app.",
    ],
  }
}

export const t3Env: Codemod = {
  name: "t3-env",
  description: `Move a Nuxt app from ${packageName} createEnv() to ViteHub Env through vite-hub/nuxt.`,
  usage: "[dir]",
  detect: async ({ cwd }) => {
    if ((await readDependencies(cwd)).has(packageName)) return { reason: `package.json depends on ${packageName}` }
    const modules = await findEnvModules(cwd)
    return modules[0] ? { reason: `${modules[0]} imports ${packageName}` } : undefined
  },
  run: migrate,
}
