import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import process from "node:process"
import { createInterface } from "node:readline/promises"

import { editViteHubConfig, insertViteHubConfig, locateViteHubConfig } from "@vite-hub/internal/config-edit"
import { featureIds } from "@vite-hub/internal/features"
import { basename, dirname, join, resolve } from "pathe"
import { minVersion, Range, subset, validRange } from "semver"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { confirmSetupChange, flattenOptions, mergeValue, planSetupAdd, readAddArgs, setupDiff, shellQuote } from "./add.ts"
import { setupExitCodes, type SetupFailure, setupFailure, writeSetupError, writeSetupJson } from "./envelope.ts"
import { gitignoreWithViteHub } from "./link.ts"
import { detectPackageManager, readSetupProject } from "./project.ts"
import { deriveSetupStack, setupStackLabels } from "./stack.ts"
import { formatInstallCommand, installArgs, installCommand, setupStatus } from "./status.ts"

import type { ViteHubCliCommand, ViteHubCliContext } from "@vite-hub/internal/cli"
import type { JsonValue } from "@vite-hub/internal/config-edit"
import type { ViteHubHost } from "@vite-hub/internal/deployment"
import type { FeatureId } from "@vite-hub/internal/features"
import type { SetupAddArgs, SetupChange, SetupOptions, SetupRerun } from "./add.ts"
import type { SetupMissing } from "./envelope.ts"
import type { SetupPackageManager, SetupProject } from "./project.ts"
import type { SetupStack } from "./stack.ts"
import type { SetupStatus } from "./status.ts"

const usage = "vitehub init <dir> --host <host> --features <id,id,...> [--option <feature.key=value>]... [--framework vite|nuxt] [--pm pnpm|npm|yarn|bun] [--no-install] [--dry-run] --yes [--json]"

const initCommandPrefix = "pnpm dlx vite-hub init"

const initHosts = ["cloudflare", "vercel", "netlify", "deno", "node"] as const satisfies readonly ViteHubHost[]
type InitHost = typeof initHosts[number]
type InitFramework = "vite" | "nuxt"
const frameworks: readonly InitFramework[] = ["vite", "nuxt"]
const packageManagers: readonly SetupPackageManager[] = ["pnpm", "npm", "yarn", "bun"]

/**
 * The packages of a new app, as `getting-started/installation.md` installs them. The Nitro and H3 versions match the
 * server integration of ViteHub. Nuxt 5 supplies Nitro 3, and its tutorials import H3 2. Valibot validates request
 * bodies in the docs' route examples.
 */
export const initPackages: Readonly<Record<InitFramework, { prod: readonly string[], dev: readonly string[] }>> = {
  nuxt: { dev: [], prod: ["vite-hub", "h3@^2.0.8", "valibot"] },
  vite: { dev: ["vite@^8", "typescript@^6", "@types/node@^24"], prod: ["vite-hub", "nitro@3.0.261103-rc", "h3@2.0.8", "valibot"] },
}

/** The Nitro 3 package that a Nuxt 4.7 app must declare, so that Nuxt builds its server with Nitro 3. */
export const nuxtNitroPackage = "nitro@^3.0.261103-rc"

/** The pinned Nuxt CLI that creates a new Nuxt app. */
export const nuxiPackage = "nuxi@3.37.0"

const nuxtTemplate = "gh:nuxt/starter#db01806fcb37f2e369fb09443c72cac696b31548"

export interface SetupInitArgs {
  dir?: string
  host?: InitHost
  /** `undefined` when `--features` is absent. */
  features?: FeatureId[]
  /** Raw `--option` values, such as `email.driver=resend`. */
  options: string[]
  framework?: InitFramework
  pm?: SetupPackageManager
  install: boolean
  dryRun: boolean
  yes: boolean
  json: boolean
  help: boolean
}

export interface SetupInitPlan {
  /** `planned` for a dry run or a plan that waits for `--yes`, `applied` when done, `unchanged` when there is nothing to do. */
  status: "planned" | "applied" | "unchanged"
  root: string
  /** `create` for a new app, `adopt` for an existing Vite or Nuxt app. */
  mode: "create" | "adopt"
  framework: InitFramework
  host: InitHost
  packageManager: SetupPackageManager
  features: readonly FeatureId[]
  implied: readonly FeatureId[]
  /** The Nuxt CLI command that creates a new Nuxt app before ViteHub adopts it. */
  scaffold?: { command: string }
  changes: readonly SetupChange[]
  install: { packages: readonly string[], devPackages: readonly string[], command?: string }
  stack: SetupStack
  nextSteps: readonly string[]
}

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function invalid(message: string): Error {
  return cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${message} Usage: ${usage}` })
}

function oneOf<T extends string>(flag: string, value: string, choices: readonly T[]): T {
  const found = choices.find(choice => choice === value)
  if (!found) throw invalid(`${flag} must be one of ${choices.join(", ")}, not ${JSON.stringify(value)}.`)
  return found
}

/** Reads the arguments. Throws `CLI_R0003` for an unknown flag or value. */
export function readInitArgs(args: readonly string[]): SetupInitArgs {
  const parsed: SetupInitArgs = { dryRun: false, help: false, install: true, json: false, options: [], yes: false }
  let features: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined]
    const value = (): string => {
      const next = inline ?? args[++index]
      if (next === undefined || (inline === undefined && next.startsWith("--"))) throw invalid(`${flag} needs a value.`)
      return next
    }
    if (flag === "--json") parsed.json = true
    else if (flag === "--dry-run") parsed.dryRun = true
    else if (flag === "--yes" || flag === "-y") parsed.yes = true
    else if (flag === "--no-install") parsed.install = false
    else if (flag === "-h" || flag === "--help") parsed.help = true
    else if (flag === "--host") parsed.host = oneOf("--host", value(), initHosts)
    else if (flag === "--features") features = value()
    else if (flag === "--option") parsed.options.push(value())
    else if (flag === "--framework") parsed.framework = oneOf("--framework", value(), frameworks)
    else if (flag === "--pm") parsed.pm = oneOf("--pm", value(), packageManagers)
    else if (arg.startsWith("-")) throw invalid(`Unknown argument ${JSON.stringify(arg)}.`)
    else if (parsed.dir === undefined) parsed.dir = arg
    else throw invalid(`Pass one folder, not ${JSON.stringify(parsed.dir)} and ${JSON.stringify(arg)}.`)
  }
  if (features !== undefined) parsed.features = readAddArgs(features.split(",").map(item => item.trim()).filter(Boolean)).features
  return parsed
}

function addArgsOf(args: SetupInitArgs & { features: FeatureId[] }): SetupAddArgs {
  return { ...readAddArgs([...args.features, ...args.options.flatMap(option => ["--option", option])]), install: true, yes: true }
}

interface InitCommandParts {
  dir: string
  host?: InitHost
  features?: readonly FeatureId[]
  options?: readonly string[]
  framework?: InitFramework
  pm?: SetupPackageManager
}

function initCommand(parts: InitCommandParts, extra: readonly string[]): string {
  const options = parts.options ?? []
  return [
    initCommandPrefix,
    shellQuote(parts.dir),
    "--host",
    shellQuote(parts.host ?? "<host>"),
    "--features",
    shellQuote(parts.features?.join(",") ?? "<id,id,...>"),
    ...options.flatMap(option => ["--option", shellQuote(option)]),
    ...(parts.framework === "nuxt" ? ["--framework", "nuxt"] : []),
    ...(parts.pm && parts.pm !== "pnpm" ? ["--pm", parts.pm] : []),
    ...extra,
  ].join(" ")
}

function rerunInit(args: SetupInitArgs, parts: InitCommandParts): string {
  return initCommand(parts, [
    ...(args.install ? [] : ["--no-install"]),
    "--yes",
    ...(args.json ? ["--json"] : []),
  ])
}

function packageNameOf(root: string): string {
  return basename(root).trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "vitehub-app"
}

function viteAppFiles(name: string, host: InitHost): Record<string, string> {
  return {
    ".gitignore": "node_modules\n.output\n.vitehub\n.env*\n!.env.example\n",
    "package.json": `${JSON.stringify({
      name,
      private: true,
      type: "module",
      scripts: { dev: "vite --port 3000 --strictPort", build: "vite build", start: "node .output/server/index.mjs" },
    }, null, 2)}\n`,
    "server/api/health.get.ts": "import { defineEventHandler } from \"h3\"\n\nexport default defineEventHandler(() => ({ ok: true }))\n",
    "tsconfig.json": `{
  "extends": ["vite-hub/tsconfig"],
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["server/**/*.ts", "vite.config.ts"]
}
`,
    "vite.config.ts": `import { defineConfig } from "vite"\nimport { vitehub } from "vite-hub"\n\nexport default defineConfig({\n  plugins: [vitehub({ host: "${host}" })],\n})\n`,
  }
}

function nuxtAppFiles(name: string, host: InitHost): Record<string, string> {
  return {
    "nuxt.config.ts": `import viteHubNuxt from "vite-hub/nuxt"\n\nexport default defineNuxtConfig({\n  modules: [\n    [viteHubNuxt, { host: "${host}" }],\n  ],\n})\n`,
    "package.json": `${JSON.stringify({ name, private: true, type: "module" }, null, 2)}\n`,
  }
}

function packageName(spec: string): string {
  const at = spec.indexOf("@", 1)
  return at === -1 ? spec : spec.slice(0, at)
}

function dlx(packageManager: SetupPackageManager, spec: string, args: readonly string[]): [string, string[]] {
  if (packageManager === "npm" || packageManager === "yarn") return ["npx", ["--yes", spec, ...args]]
  if (packageManager === "bun") return ["bunx", [spec, ...args]]
  return [packageManager, ["dlx", spec, ...args]]
}

function runScript(packageManager: SetupPackageManager, script: string): string {
  return packageManager === "npm" || packageManager === "bun" ? `${packageManager} run ${script}` : `${packageManager} ${script}`
}

type DirState = { kind: "create", exists: boolean } | { kind: "adopt", project: SetupProject }

async function readDir(root: string, env: NodeJS.ProcessEnv): Promise<DirState> {
  if (!existsSync(root)) return { exists: false, kind: "create" }
  const entries = (await readdir(root)).filter(entry => entry !== ".git")
  if (!entries.length) return { exists: true, kind: "create" }
  const project = await readSetupProject(root, env).catch(() => undefined)
  if (!project || project.framework === "none") throw setupFailure(cliErrorDiagnostics.SETUP_INIT_DIR_NOT_EMPTY({ dir: root }), setupExitCodes.conflict)
  return { kind: "adopt", project }
}

interface InitInputs extends SetupInitArgs {
  dir: string
  host: InitHost
  features: FeatureId[]
}

interface InitPlanned {
  plan: Omit<SetupInitPlan, "stack">
  stackProject: SetupProject
  writes: { path: string, before?: string, after: string }[]
  install: { prod: string[], dev: string[] }
  scaffold?: [string, string[]]
  rerun: string
}

function changeOf(path: string, before: string | undefined, after: string): SetupChange {
  return before === undefined
    ? { after, diff: setupDiff(path, "", after), kind: "create", path }
    : { after, before, diff: setupDiff(path, before, after), kind: "patch", path }
}

async function readOptional(file: string): Promise<string | undefined> {
  return existsSync(file) ? await readFile(file, "utf8") : undefined
}

function manualConfig(file: string, reason: string, host: InitHost, framework: InitFramework): SetupFailure {
  const snippet = framework === "nuxt" ? `[viteHubNuxt, { host: "${host}" }],` : `vitehub({ host: "${host}" }),`
  return setupFailure(cliErrorDiagnostics.SETUP_CONFIG_MANUAL({ file, reason, snippet }), setupExitCodes.conflict, { data: { snippet } })
}

function adoptConfig(project: SetupProject, host: InitHost, framework: InitFramework): { file: string, before?: string, after: string } {
  const file = project.configFile ?? (framework === "nuxt" ? "nuxt.config.ts" : "vite.config.ts")
  const config = project.config
  if (config && !config.ok && config.reason !== "no-vitehub") throw manualConfig(file, config.reason, host, framework)
  if (!project.configFile) {
    const name = packageNameOf(project.root)
    const files = framework === "nuxt" ? nuxtAppFiles(name, host) : viteAppFiles(name, host)
    return { after: files[file]!, file }
  }
  const before = project.configSource
  if (before === undefined) throw manualConfig(file, "no-vitehub", host, framework)
  if (!config?.ok) {
    if (config?.reason !== "no-vitehub") throw manualConfig(file, config?.reason ?? "no-vitehub", host, framework)
    const inserted = insertViteHubConfig(file, before, { host })
    if (!inserted.ok) throw manualConfig(file, inserted.reason, host, framework)
    return { after: inserted.code, before, file }
  }
  const configuredHost = config.site.keys.host
  if (configuredHost?.kind === "literal" && configuredHost.value === host) return { after: before, before, file }
  const edited = editViteHubConfig(file, before, [{ key: "host", op: "set", value: host }])
  if (!edited.ok) throw manualConfig(file, edited.reason, host, framework)
  return { after: edited.code, before, file }
}

async function planInit(args: InitInputs, root: string, state: DirState, context: Pick<ViteHubCliContext, "env" | "rootDir">): Promise<InitPlanned> {
  const name = packageNameOf(root)
  const found = state.kind === "adopt" ? state.project.framework : undefined
  const framework: InitFramework = args.framework ?? (found === "nuxt" ? "nuxt" : "vite")
  if (found && found !== framework) throw setupFailure(cliErrorDiagnostics.SETUP_INIT_FRAMEWORK_MISMATCH({ dir: root, found, framework }), setupExitCodes.conflict)
  const nuxtNeedsNitro = state.kind === "adopt" && framework === "nuxt" && (await checkNuxtVersion(root)).needsNitro
  const detected = state.kind === "adopt" ? state.project : detectPackageManager(root, undefined, context.env)
  const packageManager = args.pm ?? (detected.packageManagerSource === "default" ? "pnpm" : detected.packageManager)

  const base = new Map<string, { before?: string, after: string }>()
  let configFile: string
  if (state.kind === "create") {
    const files = framework === "vite" ? viteAppFiles(name, args.host) : nuxtAppFiles(name, args.host)
    for (const [path, after] of Object.entries(files)) base.set(path, { after })
    configFile = framework === "vite" ? "vite.config.ts" : "nuxt.config.ts"
  }
  else {
    const status = setupStatus(state.project, context.env)
    if (state.project.config?.ok && status.host.name !== args.host && status.features.some(feature => feature.id !== "env" && feature.enabled !== "off")) {
      throw setupFailure(cliErrorDiagnostics.SETUP_INIT_HOST_MIGRATION({ host: args.host }), setupExitCodes.conflict)
    }
    const config = adoptConfig(state.project, args.host, framework)
    base.set(config.file, config)
    configFile = config.file
  }
  const manifestText = base.get("package.json")?.after ?? await readOptional(join(root, "package.json"))
  const manifest: unknown = manifestText ? JSON.parse(manifestText) : {}
  const dependencies = (key: string): Record<string, unknown> => {
    const value = manifest && typeof manifest === "object" ? Reflect.get(manifest, key) : undefined
    return value && typeof value === "object" ? value : {}
  }
  const declared = (name: string, dev: boolean) => Object.hasOwn(dependencies("dependencies"), name) || (dev && Object.hasOwn(dependencies("devDependencies"), name))
  const basePackages = initPackages[framework]
  const install = {
    dev: basePackages.dev.filter(spec => !declared(packageName(spec), true)),
    prod: basePackages.prod.filter(spec => !declared(packageName(spec), false)),
  }
  if (nuxtNeedsNitro && !declared(packageName(nuxtNitroPackage), true)) install.prod.push(nuxtNitroPackage)
  const willInstall = new Set([...install.prod, ...install.dev].map(packageName))

  const configSource = base.get(configFile)!.after
  const planned: SetupProject = {
    config: locateViteHubConfig(configFile, configSource),
    configFile,
    configSource,
    declared: (name, dev) => declared(name, dev) || willInstall.has(name),
    framework,
    installed: state.kind === "adopt" ? state.project.installed : () => false,
    packageManager,
    packageManagerSource: args.pm ? "manifest" : detected.packageManagerSource,
    root,
    serverDirs: state.kind === "adopt" ? state.project.serverDirs : [],
  }
  const addArgs = addArgsOf(args)
  const parts = (extra: SetupOptions = {}, extraFeatures: readonly FeatureId[] = []): InitCommandParts => {
    const optionIds = [...new Set([...Object.keys(addArgs.options), ...Object.keys(extra)])].filter((id): id is FeatureId => featureIds.some(item => item === id))
    const options: SetupOptions = {}
    for (const id of optionIds) {
      const merged = mergeValue(addArgs.options[id], extra[id])
      if (isRecord(merged)) options[id] = { ...merged }
    }
    return {
      dir: args.dir,
      features: [...args.features, ...extraFeatures.filter(id => !args.features.includes(id))],
      framework,
      host: args.host,
      options: Object.entries(options).flatMap(([id, value]) => value ? flattenOptions(id, value) : []),
      pm: packageManager,
    }
  }
  const rerun: SetupRerun = (_args, extra, extraFeatures) => rerunInit(args, parts(extra, extraFeatures))
  const added = await planSetupAdd(planned, addArgs, context.env, rerun)
  for (const name of added.install.prod) if (!install.prod.includes(name)) install.prod.push(name)
  for (const name of added.install.dev) if (!install.dev.includes(name)) install.dev.push(name)
  for (const file of added.files) base.set(file.path, { after: file.content })
  if (added.configFile) base.set(configFile, { ...base.get(configFile), after: added.configFile.after })

  if (state.kind === "adopt") {
    const gitignore = await readOptional(join(root, ".gitignore"))
    base.set(".gitignore", { ...(gitignore === undefined ? {} : { before: gitignore }), after: gitignore === undefined ? ".vitehub\n" : gitignoreWithViteHub(gitignore) ?? gitignore })
  }

  const scaffolded = state.kind === "create" && framework === "nuxt"
  const ordered = [...base.entries()]
    .filter(([path]) => !scaffolded || !Object.hasOwn(nuxtAppFiles(name, args.host), path))
    .sort(([left], [right]) => Number(left === configFile) - Number(right === configFile))
  const writes = ordered.filter(([, file]) => file.before !== file.after).map(([path, file]) => ({ path, ...file }))
  const command = installCommand(packageManager, install.prod, install.dev)
  const scaffold = scaffolded
    ? dlx(packageManager, nuxiPackage, ["init", basename(root), "--template", nuxtTemplate, "--nightly", "5x", "--packageManager", packageManager, "--no-install", "--no-gitInit", "--no-modules", ...(state.exists ? ["--force"] : [])])
    : undefined

  const nextSteps = [
    ...(root === resolve(context.rootDir) ? [] : [`cd ${shellQuote(args.dir)}`]),
    ...(command && !args.install ? [`Install the packages: ${command}`] : []),
    `Start the dev server: ${runScript(packageManager, "dev")}`,
    ...added.plan.nextSteps,
  ]
  const finalConfig = base.get(configFile)!.after
  const stackProject: SetupProject = {
    ...planned,
    config: locateViteHubConfig(configFile, finalConfig),
    configSource: finalConfig,
    packageManager: args.install && (command || scaffold) ? packageManager : detected.packageManager,
  }
  const plan: InitPlanned["plan"] = {
    changes: writes.map(write => changeOf(write.path, write.before, write.after)),
    features: added.plan.features,
    framework,
    host: args.host,
    implied: added.plan.implied,
    install: { devPackages: install.dev, packages: install.prod, ...(command ? { command } : {}) },
    mode: state.kind,
    nextSteps,
    packageManager,
    root,
    ...(scaffold ? { scaffold: { command: [scaffold[0], ...scaffold[1]].join(" ") } } : {}),
    status: writes.length || scaffold || (command && args.install) ? "planned" : "unchanged",
  }
  return { install, plan, rerun: rerunInit(args, parts()), stackProject, writes, ...(scaffold ? { scaffold } : {}) }
}

export function setupStack(project: SetupProject, status: SetupStatus): Promise<SetupStack> {
  return deriveSetupStack(project, status, async (args) => {
    const inputs = await readInputs(readInitArgs(args))
    const rootDir = dirname(project.root)
    await planInit(inputs, resolve(rootDir, inputs.dir), { exists: false, kind: "create" }, { env: {}, rootDir })
  })
}

async function applyInit(planned: InitPlanned, install: boolean, context: ViteHubCliContext, scaffolded = false): Promise<void> {
  const { plan } = planned
  const runInstall = async () => {
    if (!install) return
    for (const [packages, dev] of [[planned.install.prod, false], [planned.install.dev, true]] as const) {
      if (!packages.length) continue
      const commandArgs = installArgs(plan.packageManager, packages, dev)
      const result = await context.spawn(plan.packageManager, commandArgs, { cwd: plan.root, env: context.env, stdout: "stderr" })
      if (result.exitCode !== 0) {
        throw setupFailure(cliErrorDiagnostics.SETUP_INSTALL_FAILED({ command: formatInstallCommand(plan.packageManager, commandArgs), exitCode: result.exitCode ?? result.signal, filesWritten: scaffolded || plan.mode === "create" }), setupExitCodes.error)
      }
    }
  }
  if (plan.mode === "adopt") await runInstall()
  for (const write of planned.writes) {
    const file = join(plan.root, write.path)
    await mkdir(dirname(file), { recursive: true })
    if (write.before === undefined) {
      try {
        await writeFile(file, write.after, { flag: "wx" })
      }
      catch {
        throw setupFailure(cliErrorDiagnostics.SETUP_FILE_EXISTS({ file: write.path }), setupExitCodes.conflict)
      }
      continue
    }
    if (await readFile(file, "utf8") !== write.before) throw setupFailure(cliErrorDiagnostics.SETUP_STALE_PLAN({ file: write.path }), setupExitCodes.stalePlan)
    await writeFile(file, write.after)
  }
  if (plan.mode === "create") await runInstall()
}

async function scaffoldNuxt(planned: InitPlanned, context: ViteHubCliContext): Promise<void> {
  const [command, commandArgs] = planned.scaffold!
  await mkdir(dirname(planned.plan.root), { recursive: true })
  const result = await context.spawn(command, commandArgs, { cwd: dirname(planned.plan.root), env: context.env, stdout: "stderr" })
  if (result.exitCode !== 0) {
    throw setupFailure(cliErrorDiagnostics.SETUP_INSTALL_FAILED({ command: [command, ...commandArgs].join(" "), exitCode: result.exitCode ?? result.signal, filesWritten: "possible" }), setupExitCodes.error)
  }
  await checkNuxtVersion(planned.plan.root, true)
}

function nuxtReleases(nuxt: JsonValue | undefined): string | undefined {
  if (typeof nuxt !== "string") return undefined
  const range = validRange(nuxt.replace(/^npm:nuxt(?:-nightly)?@/u, ""))
  if (!range || !minVersion(range)) return undefined
  return new Range(range).set.map(comparators => comparators.map(({ operator, semver, value }) =>
    typeof semver !== "symbol" && semver.major === 5 && semver.prerelease.length > 0
      ? `${operator}5.${semver.minor}.${semver.patch}`
      : value).join(" ")).join(" || ")
}

async function checkNuxtVersion(root: string, scaffolded = false): Promise<{ needsNitro: boolean }> {
  const manifest: JsonValue = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  const dependencies = isRecord(manifest) && isRecord(manifest.dependencies) ? manifest.dependencies : {}
  const devDependencies = isRecord(manifest) && isRecord(manifest.devDependencies) ? manifest.devDependencies : {}
  const releases = nuxtReleases(dependencies.nuxt ?? devDependencies.nuxt)
  if (!releases || !subset(releases, ">=4.7.0 <6.0.0")) {
    throw setupFailure(cliErrorDiagnostics.SETUP_INIT_NUXT_VERSION({ dir: root, scaffolded }), setupExitCodes.conflict)
  }
  return { needsNitro: !subset(releases, ">=5.0.0 <6.0.0") }
}

function interactive(args: SetupInitArgs): boolean {
  return !args.json && !!process.stdin.isTTY && !!process.stderr.isTTY
}

async function ask(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await terminal.question(question)).trim()
  }
  finally {
    terminal.close()
  }
}

async function readInputs(args: SetupInitArgs): Promise<InitInputs> {
  if (interactive(args)) {
    const dir = args.dir ?? (await ask("Folder of the app: ") || ".")
    const host = args.host ?? oneOf("--host", await ask(`Host (${initHosts.join(", ")}): `), initHosts)
    const features = args.features ?? readAddArgs((await ask("Features, separated by commas (none for no features): ")).split(",").map(item => item.trim()).filter(item => item && item !== "none")).features
    return { ...args, dir, features, host }
  }
  const missing: (SetupMissing & { sentence: string })[] = []
  if (args.dir === undefined) missing.push({ field: "dir", sentence: "Pass the app folder, such as `vitehub init my-app`," })
  if (args.host === undefined) missing.push({ choices: initHosts, field: "host", sentence: `Pass --host (${initHosts.join(", ")})` })
  if (args.features === undefined) missing.push({ choices: featureIds, field: "features", sentence: "Pass --features with feature ids separated by commas, such as `--features kv,queue` (run `vitehub catalog` to list them)," })
  if (!missing.length) return { ...args, dir: args.dir!, features: args.features!, host: args.host! }
  const message = missing.map(item => `${item.sentence} when running without an interactive terminal.`).join(" ")
  throw setupFailure(cliErrorDiagnostics.SETUP_INPUT_NEEDED({ message: `[vitehub] ${message}` }), setupExitCodes.inputNeeded, {
    missing: missing.map(({ sentence: _sentence, ...item }) => item),
    rerun: rerunInit(args, {
      dir: args.dir ?? "<dir>",
      options: args.options,
      ...(args.features ? { features: args.features } : {}),
      ...(args.host ? { host: args.host } : {}),
      ...(args.framework ? { framework: args.framework } : {}),
      ...(args.pm ? { pm: args.pm } : {}),
    }),
  })
}

function writePlan(plan: SetupInitPlan, context: ViteHubCliContext): void {
  if (plan.scaffold) context.stdout.write(`Run: ${plan.scaffold.command}\n`)
  for (const change of plan.changes) {
    if (change.kind === "create") context.stdout.write(`create ${change.path}\n`)
    else context.stdout.write(change.diff.endsWith("\n") ? change.diff : `${change.diff}\n`)
  }
  const lines = [
    ...(plan.install.command ? [`Install: ${plan.install.command}`] : []),
    ...(plan.implied.length ? [`Also turns on: ${plan.implied.join(", ")}`] : []),
    ...stackLines(plan.stack),
  ]
  context.stdout.write(`${lines.join("\n")}\n`)
}

function stackLines(stack: SetupStack): string[] {
  const { command, omissions } = setupStackLabels(stack)
  return [`Stack: ${command}`, ...(omissions ? [`Stack omissions: ${omissions}`] : [])]
}

function writeResult(plan: SetupInitPlan, context: ViteHubCliContext): void {
  const features = plan.features.length ? ` with ${plan.features.join(", ")}` : ""
  if (plan.status === "unchanged") context.stdout.write(`${plan.root} already has this stack. Nothing to change.\n`)
  else context.stdout.write(`${plan.mode === "create" ? "Created" : "Set up"} ${plan.root} for ${plan.host}${features}.\n`)
  context.stdout.write(`${stackLines(plan.stack).join("\n")}\n`)
  context.stdout.write(`\nNext steps:\n${plan.nextSteps.map(step => `- ${step}`).join("\n")}\n`)
}

async function runInit(rawArgs: string[], context: ViteHubCliContext): Promise<number> {
  let json = rawArgs.includes("--json")
  try {
    const parsed = readInitArgs(rawArgs)
    json = parsed.json
    if (parsed.help) {
      context.stdout.write(`Usage: ${usage}\n\n${initCommandDefinition.description}\n`)
      return setupExitCodes.done
    }
    const args = await readInputs(parsed)
    const root = resolve(context.rootDir, args.dir)
    const state = await readDir(root, context.env)
    let planned = await planInit(args, root, state, context)
    const plan: SetupInitPlan = {
      ...planned.plan,
      stack: await setupStack(planned.stackProject, setupStatus(planned.stackProject, context.env)),
    }
    if (plan.status === "unchanged" || args.dryRun) {
      if (args.json) writeSetupJson(context, plan)
      else if (plan.status === "unchanged") writeResult(plan, context)
      else writePlan(plan, context)
      return setupExitCodes.done
    }
    if (!args.yes) {
      if (!interactive(args)) {
        if (!args.json) writePlan(plan, context)
        throw setupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] `vitehub init` writes files and was not confirmed. Without a terminal, pass --yes." }), setupExitCodes.inputNeeded, {
          data: plan,
          rerun: planned.rerun,
        })
      }
      writePlan(plan, context)
      if (!await confirmSetupChange()) throw setupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] The change was not confirmed. Nothing was written." }), setupExitCodes.error)
    }
    if (planned.scaffold) {
      await scaffoldNuxt(planned, context)
      planned = await planInit({ ...args, pm: plan.packageManager }, root, await readDir(root, context.env), context)
    }
    await applyInit(planned, args.install, context, !!plan.scaffold)
    const project = await readSetupProject(root, context.env)
    const applied: SetupInitPlan = {
      ...planned.plan,
      mode: plan.mode,
      stack: await setupStack(project, setupStatus(project, context.env)),
      status: "applied",
      ...(plan.scaffold ? { scaffold: plan.scaffold } : {}),
    }
    if (args.json) writeSetupJson(context, applied)
    else writeResult(applied, context)
    return setupExitCodes.done
  }
  catch (error: unknown) {
    return writeSetupError(context, json, error)
  }
}

export const initCommandDefinition: ViteHubCliCommand = {
  description: "Create a ViteHub app in a folder, or set up an existing Vite or Nuxt app, with a host and features.",
  name: "init",
  run: runInit,
  usage,
}
