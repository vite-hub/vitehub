import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, posix } from "node:path"

import { detectStyle, end, findProperty, indentAt, keyName, line, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import { listSourceFiles, normalizePathDefinitionName } from "@vite-hub/internal/definition-catalog"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import packageJson from "../../package.json" with { type: "json" }
import { addViteHubOptions, ConfigEditor, createLineResolver, findViteHubOption, planHost, useViteHubModule } from "../shared/config-editor.ts"
import { detectNuxtModule } from "../shared/detect.ts"
import { findModuleEntry, literalValue, readNuxtConfig, staticOptionsObject, unwrapExpression } from "../shared/nuxt-config.ts"
import { editPackageJson } from "../shared/package-json.ts"
import { CodemodError } from "../types.ts"

import type { CallExpression, File } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const moduleName = "nuxt-cron"

/** nuxt-cron presets, from its runtime. `everySecond` has six fields, which Schedule cannot run. */
export const cronPresets: Record<string, string> = {
  everySecond: "* * * * * *",
  everyMinute: "* * * * *",
  everyTwoMinutes: "*/2 * * * *",
  everyThreeMinutes: "*/3 * * * *",
  everyFourMinutes: "*/4 * * * *",
  everyFiveMinutes: "*/5 * * * *",
  everyTenMinutes: "*/10 * * * *",
  everyFifteenMinutes: "*/15 * * * *",
  everyThirtyMinutes: "*/30 * * * *",
  hourly: "0 * * * *",
  // nuxt-cron 1.8.0 uses even hours for this name; preserve its runtime behavior.
  everyOddHour: "0 */2 * * *",
  everyTwoHours: "0 */2 * * *",
  everyThreeHours: "0 */3 * * *",
  everyFourHours: "0 */4 * * *",
  everySixHours: "0 */6 * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 0",
  quarterly: "0 0 1 */3 *",
  yearly: "0 0 1 1 *",
}

interface ModuleOptions {
  jobsDir: string
  timeZone?: Node
  runOnInit?: boolean
}

/** The cron string of `defineCronHandler()`'s first argument: a preset name or a function that returns a literal. */
function cronOf(node: Node): string | undefined {
  const literal = literalValue(node)
  if (typeof literal === "string") return cronPresets[literal]
  const value = unwrapExpression(node)
  if (value.type !== "ArrowFunctionExpression" && value.type !== "FunctionExpression") return undefined
  if (value.body.type !== "BlockStatement") {
    const returned = literalValue(value.body)
    return typeof returned === "string" ? returned : undefined
  }
  const [statement] = value.body.body
  if (value.body.body.length !== 1 || statement?.type !== "ReturnStatement" || !statement.argument) return undefined
  const returned = literalValue(statement.argument)
  return typeof returned === "string" ? returned : undefined
}

interface JobResult {
  edits: FileEdit[]
  followUps: FollowUp[]
  migrated: boolean
}

/** Moves one `server/<jobsDir>/<file>` to `server/schedules/<name>.ts` as a Schedule Definition. */
function migrateJob(file: string, target: string, code: string, defaults: ModuleOptions, processDriver: boolean): JobResult {
  const follow = (node: Node | undefined, message: string): FollowUp => ({ file, line: node ? line(node) : undefined, message })
  let program: File
  try {
    program = parseProgram(code, { typescript: !/\.(?:c|m)?js$/.test(file) })
  }
  catch {
    return { edits: [], followUps: [follow(undefined, "The codemod could not parse this cron job. Move it to server/schedules/ with defineSchedule() by hand.")], migrated: false }
  }
  const exported = program.program.body.find(statement => statement.type === "ExportDefaultDeclaration")
  const call = exported?.type === "ExportDefaultDeclaration" ? unwrapExpression(exported.declaration) : undefined
  const callee = call?.type === "CallExpression" && call.callee.type === "Identifier" ? call.callee.name : undefined
  if (call?.type !== "CallExpression" || callee !== "defineCronHandler") {
    return { edits: [], followUps: [follow(exported, "This file does not export defineCronHandler(...) by default. Move it to server/schedules/ with defineSchedule() by hand.")], migrated: false }
  }
  const handlerCall: CallExpression = call
  const [time, callback, options] = handlerCall.arguments
  if (!time || !callback || callback.type === "SpreadElement" || callback.type === "ArgumentPlaceholder") {
    return { edits: [], followUps: [follow(handlerCall, "defineCronHandler() needs a time and a callback. Move this job by hand.")], migrated: false }
  }
  const cron = cronOf(time)
  if (!cron) {
    return { edits: [], followUps: [follow(time, "The cron time is computed, so the codemod cannot read it. Write it as a five-field cron string in defineSchedule() by hand.")], migrated: false }
  }
  if (cron.trim().split(/\s+/).length !== 5) {
    return { edits: [], followUps: [follow(time, `"${cron}" has six fields, so it runs every few seconds. Schedule runs at most once a minute. Keep this job on a timer, such as setInterval() in a Nitro plugin, or choose a five-field cron.`)], migrated: false }
  }
  const followUps: FollowUp[] = []
  let timeZoneOption = defaults.timeZone
  let runOnInit = defaults.runOnInit
  const optionsObject = options ? staticOptionsObject(options) : undefined
  if (options && !optionsObject) {
    return { edits: [], followUps: [follow(options, "The options cannot be read completely, so this job stayed with nuxt-cron. Use an object literal with explicit, unique property names, then run the codemod again.")], migrated: false }
  }
  if (optionsObject) {
    for (const property of optionsObject.properties) {
      const key = property.type === "ObjectProperty" ? keyName(property.key, property.computed) : undefined
      const value = property.type === "ObjectProperty" ? literalValue(property.value) : undefined
      if (key === "timeZone" && property.type === "ObjectProperty") timeZoneOption = property.value
      else if (key === "runOnInit" && typeof value === "boolean") runOnInit = value
      else followUps.push(follow(property, "This defineCronHandler() option has no Schedule equivalent and was dropped."))
    }
  }
  const zone = timeZoneOption ? literalValue(timeZoneOption) : undefined
  if (timeZoneOption && typeof zone !== "string") {
    return { edits: [], followUps: [follow(handlerCall, "The timeZone is not a string literal, so this job stayed with nuxt-cron. Set its timeZone in defineSchedule() by hand.")], migrated: false }
  }
  let timeZone = typeof zone === "string" ? zone : undefined
  // The cron package read zones such as "UTC+0" through Luxon. They mean UTC.
  if (timeZone && /^(?:utc|gmt|etc\/utc|z)(?:[+-]0{1,2}(?::?00)?)?$/i.test(timeZone)) timeZone = undefined
  if (timeZone && !processDriver) {
    followUps.push(follow(handlerCall, `This job ran in ${timeZone}. Hosts other than Node run Schedules in UTC, so the codemod dropped timeZone and the cron now runs in UTC. Convert the cron to UTC.`))
    timeZone = undefined
  }
  if (runOnInit) followUps.push(follow(handlerCall, "runOnInit ran this job when the server started. Schedule has no such option. Call the job from a Nitro plugin if it must run at startup."))

  const output = new MagicString(code)
  const style = detectStyle(code, program)
  // Re-indent the callback from the column of its first line to the new property.
  const callbackIndent = indentAt(code, start(callback))
  const callbackCode = code.slice(start(callback), end(callback)).split("\n").map((text, index) => index && text.startsWith(callbackIndent) ? text.slice(callbackIndent.length) : text).join("\n")
  const fields = [`cron: ${quoteString(cron, style)}`]
  if (timeZone) fields.push(`timeZone: ${quoteString(timeZone, style)}`)
  fields.push(`handler: ${callbackCode}`)
  const multiline = callbackCode.includes("\n")
  const indent = style.indent
  output.overwrite(start(handlerCall), end(handlerCall), multiline
    ? `defineSchedule({\n${fields.map(field => `${indent}${field.replaceAll("\n", `\n${indent}`)},`).join("\n")}\n})`
    : `defineSchedule({ ${fields.join(", ")} })`)
  const semicolon = style.semicolons ? ";" : ""
  const importText = `import { defineSchedule } from ${quoteString("vite-hub/schedule", style)}${semicolon}`
  let replaced = false
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "#nuxt/cron") continue
    if (!replaced) output.overwrite(start(statement), end(statement), importText)
    else output.remove(start(statement), code[end(statement)] === "\n" ? end(statement) + 1 : end(statement))
    replaced = true
  }
  if (!replaced) output.prepend(`${importText}\n\n`)
  walk(program, (node) => {
    if (node.type !== "ImportDeclaration" || !node.source.value.startsWith(".")) return
    const before = posix.join(posix.dirname(file), node.source.value)
    const after = posix.join(posix.dirname(target), node.source.value)
    if (before !== after) followUps.push(follow(node, `This relative import may point elsewhere after the move to ${target}. Check it.`))
  })
  return {
    edits: [{ path: file, before: code, after: null }, { path: target, before: undefined, after: output.toString() }],
    followUps,
    migrated: true,
  }
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const config = await readNuxtConfig(cwd)
  if (!staticOptionsObject(config.root)) throw new CodemodError(`${config.fileName} has options that cannot be read completely. Use an object literal with explicit, unique property names, then run the codemod again.`)
  const optionsProperty = findProperty(config.root, "cron")
  const defaults: ModuleOptions = { jobsDir: "cron" }
  const inlineEntry = findModuleEntry(config, moduleName)?.inlineOptions
  for (const node of [optionsProperty?.value, inlineEntry]) {
    if (!node) continue
    const object = staticOptionsObject(node)
    if (!object) throw new CodemodError(`${config.fileName} sets cron or inline nuxt-cron options that cannot be read completely. Use an object literal with explicit, unique property names, then run the codemod again.`)
    for (const property of object.properties) {
      if (property.type !== "ObjectProperty") continue
      const key = keyName(property.key, property.computed)
      const value = literalValue(property.value)
      if (key === "jobsDir") {
        if (typeof value !== "string") throw new CodemodError(`${config.fileName} sets a computed cron jobsDir. Use a string literal, then run the codemod again.`)
        defaults.jobsDir = value
      }
      if (key === "timeZone") defaults.timeZone = property.value
      if (key === "runOnInit" && typeof value === "boolean") defaults.runOnInit = value
    }
  }
  const jobsDirectory = posix.join("server", defaults.jobsDir)
  const files = (await glob(["**/*.{ts,js,mjs}"], { cwd: join(cwd, jobsDirectory) })).sort()
  if (!files.length) throw new CodemodError(`${jobsDirectory} has no cron jobs, so there is nothing to migrate. Remove ${moduleName} by hand.`)

  const host = planHost(config).host
  if (!host) throw new CodemodError(`${config.fileName} has no statically known ViteHub host. Set the effective vitehub.host or inline module host to a string literal, then run the codemod again.`)
  if (host === "deno") throw new CodemodError('The ViteHub "deno" host cannot provide Schedule through the Nuxt integration. Keep nuxt-cron or compose an explicit Deno scheduling integration by hand.')
  if (findViteHubOption(config, "schedule")) {
    throw new CodemodError(`${config.fileName} already sets vitehub.schedule or inline module schedule options. Merge the Schedule options and move the cron jobs by hand.`)
  }
  const processDriver = host === "node"
  const kv = findViteHubOption(config, "kv")
  if (processDriver && kv && literalValue(kv.value) === false) {
    throw new CodemodError(`${config.fileName} disables KV, but the Schedule Process Runtime needs its default KV store. Set the effective vitehub.kv or inline module kv to true or configure a default store, then run the codemod again.`)
  }
  const schedulesDirectory = join(cwd, "server/schedules")
  const existingNames = new Set(listSourceFiles(schedulesDirectory).map(file => normalizePathDefinitionName(schedulesDirectory, file)))
  const jobs = files.map((relativeFile) => {
    const name = relativeFile.replace(/\.(?:ts|js|mjs)$/, "").replace(/\.cron$/, "")
    const target = posix.join("server/schedules", `${name}.ts`)
    return { file: posix.join(jobsDirectory, relativeFile), target, scheduleName: normalizePathDefinitionName(schedulesDirectory, join(cwd, target)) }
  })
  const targetCounts = new Map<string, number>()
  for (const { scheduleName } of jobs) targetCounts.set(scheduleName, (targetCounts.get(scheduleName) ?? 0) + 1)
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  let migrated = 0
  for (const { file, target, scheduleName } of jobs) {
    if (targetCounts.get(scheduleName)! > 1) {
      followUps.push({ file, message: `Multiple cron jobs collide at ${target}, so none of them were moved. Give them unique names and run the codemod again.` })
      continue
    }
    if (existingNames.has(scheduleName) || existsSync(join(cwd, target))) {
      followUps.push({ file, message: `A Schedule named "${scheduleName}" already exists, so this job was not moved. Rename one of them and move the job by hand.` })
      continue
    }
    const job = migrateJob(file, target, await readFile(join(cwd, file), "utf8"), defaults, processDriver)
    edits.push(...job.edits)
    followUps.push(...job.followUps)
    if (job.migrated) migrated++
  }
  if (!migrated) throw new CodemodError(`No cron job in ${jobsDirectory} could be migrated:\n${followUps.map(entry => `  ${entry.file}${entry.line ? `:${entry.line}` : ""} ${entry.message}`).join("\n")}`)
  const kept = files.length - migrated

  const editor = new ConfigEditor(config)
  const removedRootProperties = new Set<Node>()
  // The module stays while jobs are left in its folder.
  const rootEntries = useViteHubModule(editor, config, kept ? undefined : moduleName)
  if (optionsProperty && !kept) {
    editor.removeItem(optionsProperty)
    removedRootProperties.add(optionsProperty)
  }
  const style = editor.style
  const scheduleValue = processDriver ? `{ runtime: { driver: ${quoteString("process", style)} } }` : "true"
  // The Process Runtime records Schedule Runs in the default KV store, so it needs KV.
  const addKv = processDriver && !kv
  const { host: added, hostNote } = addViteHubOptions(editor, config, {
    options: [
      { key: "schedule", label: "the Schedule options", value: () => scheduleValue },
      ...(addKv ? [{ key: "kv", label: "the KV options", value: () => "true" }] : []),
    ],
    rootEntries,
    removedRootProperties,
  })
  editor.removeUnusedBindings()
  const configCode = editor.output.toString()
  const lineOf = createLineResolver(configCode)
  const configFollowUps: FollowUp[] = []
  if (hostNote) configFollowUps.push({ file: config.fileName, line: lineOf(["vitehub", "host"]), message: hostNote })
  if (!findModuleEntry(config, moduleName) && !kept) {
    configFollowUps.push({ file: config.fileName, message: `${config.fileName} adds ${moduleName} in a way the codemod cannot remove, such as a conditional spread. Remove it from modules by hand.` })
  }
  const packageResult = await editPackageJson(cwd, packageJson.version, { remove: kept ? [] : [moduleName], add: ["vite-hub"] })
  edits.unshift({ path: config.fileName, before: config.code, after: configCode })
  if (packageResult.edit) edits.push(packageResult.edit)
  const notes = [
    processDriver
      ? "On Node, the Process Runtime runs each Schedule in the server process, as nuxt-cron did. Run one server process or replica: the runtime does not lock across processes."
      : `On ${host}, the host runs each Schedule from its own cron, so jobs keep running on serverless hosts. Schedules run in UTC.`,
    addKv
      ? "The Process Runtime records Schedule Runs in KV, so the codemod set vitehub.kv to true. On Node that stores them under .vitehub/data/kv. Run a Schedule by hand with `vitehub schedule run <name>` while vite dev runs."
      : "Run a Schedule by hand with `vitehub schedule run <name>` while vite dev runs.",
  ]
  if (kept) notes.push(`${moduleName} stays because ${kept} job${kept === 1 ? "" : "s"} could not be moved. Remove it after the follow-ups.`)
  return {
    summary: `moved ${migrated} cron job${migrated === 1 ? "" : "s"} from ${jobsDirectory} to server/schedules${added ? `, host "${added}"` : ""}.`,
    edits,
    followUps: [...configFollowUps, ...followUps],
    notes,
    nextSteps: [
      `Run \`${packageResult.installCommand}\` to install vite-hub${kept ? "" : ` and remove ${moduleName}`}.`,
      "Run `npx nuxi prepare`, then type-check the app.",
    ],
  }
}

export const nuxtCron: Codemod = {
  name: moduleName,
  description: "Move nuxt-cron jobs to ViteHub Schedule Definitions through vite-hub/nuxt.",
  usage: "[dir]",
  detect: ({ cwd }) => detectNuxtModule(cwd, moduleName, ["cron"]),
  run: migrate,
}
