import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"

export type BoxRequirement = "codex" | "codex-cli" | "github" | (string & {})

export type BoxValue<T, Context> = T | ((context: Context) => T | undefined | Promise<T | undefined>)

export interface BoxDefinition<Context = unknown> {
  cwd?: BoxValue<string, Context>
  home?: BoxValue<string, Context>
  requires?: readonly BoxRequirement[]
  runtime: BoxRuntime
}

export interface BoxRuntime {
  readonly name: string
  resolve(input: ResolvedBoxInput): Promise<ResolvedBox>
}

export interface ResolvedBoxInput {
  cwd?: string
  home?: string
  requirements: readonly BoxRequirement[]
}

export interface ResolvedBoxEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home?: string
}

export interface ResolvedBoxRequirement {
  readonly command: string
  readonly name: BoxRequirement
}

export interface ResolvedBox {
  readonly cache: {
    readonly state: "disposable"
  }
  readonly environment: ResolvedBoxEnvironment
  readonly isolation: "none"
  readonly requirements: readonly ResolvedBoxRequirement[]
  readonly runtime: string
  readonly workspace: {
    readonly path?: string
    readonly state: "authoritative" | "disposable"
  }
}

export interface ResolveBoxOptions {
  requires?: readonly BoxRequirement[]
}

export async function resolveBox<Context>(
  definition: BoxDefinition<Context>,
  context: Context,
  options: ResolveBoxOptions = {},
): Promise<ResolvedBox> {
  if (!definition || typeof definition !== "object" || !definition.runtime || typeof definition.runtime.resolve !== "function") {
    throw new TypeError("[vitehub] Box requires a runtime.")
  }
  const [cwd, home] = await Promise.all([
    resolveValue(definition.cwd, context),
    resolveValue(definition.home, context),
  ])
  return await definition.runtime.resolve({
    ...(cwd ? { cwd } : {}),
    ...(home ? { home } : {}),
    requirements: [...new Set([...(definition.requires || []), ...(options.requires || [])])],
  })
}

export function trustedHost(): BoxRuntime {
  return {
    name: "trusted-host",
    async resolve(input) {
      const cwd = input.cwd ? resolve(input.cwd) : undefined
      const home = input.home ? resolve(input.home) : process.env.HOME || homedir()
      await Promise.all([
        cwd ? assertDirectory(cwd, "workspace") : undefined,
        input.home ? assertDirectory(home!, "Home") : undefined,
      ])
      const env = {
        ...process.env,
        ...(home ? { HOME: home } : {}),
        ...(input.home
          ? {
              CODEX_HOME: join(home!, ".codex"),
              XDG_CONFIG_HOME: join(home!, ".config"),
            }
          : {}),
      }
      const requirements = []
      for (const name of input.requirements) requirements.push(await resolveRequirement(name, env, cwd))
      const environment = { home } as ResolvedBoxEnvironment
      Object.defineProperty(environment, "env", { enumerable: false, value: Object.freeze(env) })
      return {
        cache: { state: "disposable" },
        environment,
        isolation: "none",
        requirements,
        runtime: "trusted-host",
        workspace: cwd ? { path: cwd, state: "authoritative" } : { state: "disposable" },
      }
    },
  }
}

async function resolveValue<T, Context>(value: BoxValue<T, Context> | undefined, context: Context): Promise<T | undefined> {
  return typeof value === "function"
    ? await (value as (context: Context) => T | undefined | Promise<T | undefined>)(context)
    : value
}

async function assertDirectory(path: string, label: string) {
  const item = await stat(path).catch(() => undefined)
  if (!item?.isDirectory()) throw new Error(`[vitehub] Box ${label} directory does not exist: ${path}`)
}

const requirementCommands: Record<string, { args: string[], command: string }> = {
  codex: { args: ["login", "status"], command: "codex" },
  "codex-cli": { args: [], command: "codex" },
  github: { args: ["auth", "status"], command: "gh" },
}

async function resolveRequirement(
  name: BoxRequirement,
  env: Record<string, string | undefined>,
  cwd: string | undefined,
): Promise<ResolvedBoxRequirement> {
  if (!name.trim()) throw new Error("[vitehub] Box requirements must be non-empty names.")
  const check = requirementCommands[name] || { args: [], command: name }
  const executable = await findExecutable(check.command, env.PATH, env.PATHEXT)
  if (!executable) {
    throw new Error(`[vitehub] Box requirement "${name}" is unavailable: ${check.command} is not on PATH.`)
  }
  if (check.args.length) {
    try {
      await promisify(execFile)(executable, check.args, { cwd, env, shell: isWindowsCommandShim(executable), timeout: 10_000 })
    }
    catch (error) {
      const detail = typeof error === "object" && error && "stderr" in error
        ? String(error.stderr).trim()
        : error instanceof Error ? error.message : String(error)
      throw new Error(`[vitehub] Box requirement "${name}" failed${detail ? `: ${detail}` : "."}`, { cause: error })
    }
  }
  return { command: check.command, name }
}

async function findExecutable(command: string, path: string | undefined, pathExt: string | undefined) {
  const names = [
    command,
    ...(pathExt || "").split(";").map(extension => extension.trim()).filter(Boolean).flatMap((extension) => {
      return command.toLowerCase().endsWith(extension.toLowerCase()) ? [] : [`${command}${extension}`]
    }),
  ]
  const candidates = command.includes("/") || command.includes("\\") || isAbsolute(command)
    ? names.map(name => resolve(name))
    : (path || "").split(delimiter).filter(Boolean).flatMap(directory => names.map(name => join(directory, name)))
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate
  }
}

function isWindowsCommandShim(path: string) {
  return process.platform === "win32" && /\.(?:bat|cmd)$/i.test(path)
}
