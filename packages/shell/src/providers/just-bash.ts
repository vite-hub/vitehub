import type { CommandName } from "just-bash/browser"
import type { IFileSystem } from "just-bash"

import { analyzeShellCommand } from "../command/analyze.ts"
import { parseShellCommand } from "../command/parse.ts"

import type {
  ShellBoundary,
  ShellExecutionProvider,
  ShellObservation,
  ShellRuntimeExecOptions,
} from "../runtime/types.ts"

export interface JustBashFileSystem extends IFileSystem {
  readonly writeFs: boolean
}

export interface JustBashProviderOptions {
  commands?: string[]
  cwd?: string
  fs: JustBashFileSystem
  networkGrants?: ShellNetworkGrantExecutor
}

export interface ShellNetworkGrantExecutor {
  executeSourceRequest(input: ShellNetworkRequest): Promise<ShellNetworkRequestResult>
}

export interface ShellNetworkRequest {
  body?: unknown
  method: "GET" | "HEAD" | "POST"
  url: string
}

export interface ShellNetworkRequestResult {
  content: string | Uint8Array
}

export function createJustBashProvider(options: JustBashProviderOptions): ShellExecutionProvider {
  const boundary: ShellBoundary = {
    cwd: true,
    env: true,
    filesystem: {
      mountPoint: "/workspace",
      writable: options.fs.writeFs,
    },
    network: Boolean(options.networkGrants),
    processes: {
      background: false,
      interactive: false,
    },
    streaming: false,
    timeout: {
      enforcedBy: "provider",
      supported: true,
    },
  }

  return {
    analyze: analyzeShellCommand,
    boundary,
    async exec(command: string, execOptions: ShellRuntimeExecOptions = {}) {
      const result = await withProviderTimeout(command, execOptions, async () => {
        const curlResult = await runControlledCurlCommand(command, {
          cwd: execOptions.cwd || options.cwd,
          networkGrants: options.networkGrants,
        })
        if (curlResult) return curlResult

        const { Bash } = await import("just-bash/browser")
        const bash = new Bash({
          commands: options.commands as CommandName[] | undefined,
          cwd: options.cwd,
          fs: options.fs,
        })
        const signal = typeof execOptions.timeout === "number"
          ? AbortSignal.timeout(execOptions.timeout)
          : undefined
        return await bash.exec(command, {
          cwd: execOptions.cwd,
          env: execOptions.env,
          signal,
        })
          .then(result => ({
            command,
            cwd: execOptions.cwd,
            event: "command_finished",
            exitCode: result.exitCode,
            stderr: result.stderr,
            stdout: result.stdout,
          } satisfies ShellObservation))
      })
      execOptions.onStdout?.(result.stdout)
      execOptions.onStderr?.(result.stderr)
      return {
        command: result.command ?? command,
        cwd: result.cwd ?? execOptions.cwd,
        event: result.timedOut ? "command_timed_out" : result.event,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut,
      }
    },
  }
}

async function runControlledCurlCommand(
  command: string,
  options: { cwd?: string, networkGrants?: ShellNetworkGrantExecutor },
): Promise<ShellObservation | undefined> {
  if (!mentionsCurlCommand(command)) return undefined

  const parsed = parseControlledCurlCommand(command)
  if (!parsed.ok) return policyDeniedCurl(command, options.cwd, parsed.error)
  if (!options.networkGrants) {
    return policyDeniedCurl(command, options.cwd, "No API-backed Source request descriptors are visible in this workspace.")
  }

  try {
    const result = await options.networkGrants.executeSourceRequest({
      body: parsed.body,
      method: parsed.method,
      url: parsed.url,
    })
    return {
      command,
      cwd: options.cwd,
      event: "command_finished",
      exitCode: 0,
      stderr: "",
      stdout: typeof result.content === "string" ? result.content : new TextDecoder().decode(result.content),
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const httpFailure = message.includes("HTTP request failed")
    return {
      command,
      cwd: options.cwd,
      event: httpFailure ? "command_finished" : "policy_denied",
      exitCode: httpFailure ? 22 : 126,
      stderr: `${message}\n`,
      stdout: "",
    }
  }
}

type ParsedControlledCurl =
  | { body?: unknown, method: "GET" | "HEAD" | "POST", ok: true, url: string }
  | { error: string, ok: false }

function parseControlledCurlCommand(command: string): ParsedControlledCurl {
  if (hasUnsupportedCurlShellSyntax(command)) {
    return { error: "Controlled curl must be a single command without pipes, redirects, chaining, command substitution, or heredocs.", ok: false }
  }

  let words: string[]
  try {
    words = parseShellCommand(command)
  }
  catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false }
  }

  if (words[0] !== "curl") return { error: "Controlled curl command must start with curl.", ok: false }

  let body: unknown
  let method: "GET" | "HEAD" | "POST" | undefined
  let url: string | undefined

  try {
    for (let index = 1; index < words.length; index += 1) {
      const word = words[index]!
      if (word === "-s" || word === "-S" || word === "-sS" || word === "--silent" || word === "--show-error" || word === "-L" || word === "--location") {
        continue
      }
      if (word === "-X" || word === "--request") {
        const value = words[++index]
        if (!value) return { error: `${word} requires a method.`, ok: false }
        method = parseCurlMethod(value)
        if (!method) return { error: `Unsupported curl request method: ${value}.`, ok: false }
        continue
      }
      if (word.startsWith("--request=")) {
        method = parseCurlMethod(word.slice("--request=".length))
        if (!method) return { error: `Unsupported curl request method: ${word.slice("--request=".length)}.`, ok: false }
        continue
      }
      if (word === "--url") {
        const value = words[++index]
        if (!value) return { error: "--url requires a URL.", ok: false }
        url = setCurlUrl(url, value)
        continue
      }
      if (word.startsWith("--url=")) {
        url = setCurlUrl(url, word.slice("--url=".length))
        continue
      }
      if (word === "--json") {
        const value = words[++index]
        if (!value) return { error: "--json requires a JSON body.", ok: false }
        const parsed = parseJsonCurlBody(value)
        if (!parsed.ok) return parsed
        body = parsed.body
        method ??= "POST"
        continue
      }
      if (word.startsWith("--json=")) {
        const parsed = parseJsonCurlBody(word.slice("--json=".length))
        if (!parsed.ok) return parsed
        body = parsed.body
        method ??= "POST"
        continue
      }
      if (word === "-d" || word === "--data" || word === "--data-raw" || word === "--data-binary") {
        const value = words[++index]
        if (!value) return { error: `${word} requires a body.`, ok: false }
        body = parseCurlDataBody(value)
        method ??= "POST"
        continue
      }
      if (word.startsWith("-d") && word !== "-d") {
        body = parseCurlDataBody(word.slice(2))
        method ??= "POST"
        continue
      }
      if (word.startsWith("--data=") || word.startsWith("--data-raw=") || word.startsWith("--data-binary=")) {
        body = parseCurlDataBody(word.slice(word.indexOf("=") + 1))
        method ??= "POST"
        continue
      }
      if (word === "-H" || word === "--header" || word === "-b" || word === "--cookie" || word.startsWith("--header=") || word.startsWith("--cookie=")) {
        return { error: "Controlled curl injects Source credentials itself; do not pass headers or cookies in the command.", ok: false }
      }
      if (word.startsWith("-")) return { error: `Unsupported curl flag: ${word}.`, ok: false }
      url = setCurlUrl(url, word)
    }
  }
  catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false }
  }

  if (!url) return { error: "Controlled curl requires a URL.", ok: false }
  try {
    url = new URL(url).toString()
  }
  catch {
    return { error: `Controlled curl URL is invalid: ${url}.`, ok: false }
  }

  return {
    body,
    method: method ?? "GET",
    ok: true,
    url,
  }
}

function mentionsCurlCommand(command: string): boolean {
  return parseShellCommandLenient(command)[0] === "curl"
}

function hasUnsupportedCurlShellSyntax(command: string): boolean {
  let quote: "'" | "\"" | undefined
  let escaped = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    const next = command[index + 1]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      continue
    }
    if (char === "|" || char === ";" || char === "<" || char === ">" || char === "`" || char === "$" && next === "(") return true
    if ((char === "&" || char === "|") && next === char) return true
  }
  return /<<-?/.test(command)
}

function parseShellCommandLenient(command: string): string[] {
  try {
    return parseShellCommand(command)
  }
  catch {
    return command.trim().split(/\s+/).filter(Boolean)
  }
}

function parseCurlDataBody(value: string): unknown {
  const parsed = parseJsonCurlBody(value)
  return parsed.ok ? parsed.body : value
}

function parseCurlMethod(value: string): "GET" | "HEAD" | "POST" | undefined {
  const method = value.toUpperCase()
  return method === "GET" || method === "HEAD" || method === "POST" ? method : undefined
}

function parseJsonCurlBody(value: string): { body: unknown, ok: true } | { error: string, ok: false } {
  try {
    return { body: JSON.parse(value), ok: true }
  }
  catch {
    return { error: "--json body must be valid JSON.", ok: false }
  }
}

function setCurlUrl(current: string | undefined, next: string): string {
  if (current) throw new Error("Controlled curl accepts exactly one URL.")
  return next
}

function policyDeniedCurl(command: string, cwd: string | undefined, message: string): ShellObservation {
  return {
    command,
    cwd,
    event: "policy_denied",
    exitCode: 126,
    stderr: `[vitehub] ${message}\n`,
    stdout: [
      "[vitehub] Controlled curl request was not run.",
      "Inspect `.vitehub/sources/<sourceKey>.json`, then retry with a single curl command that matches a visible Source request descriptor.",
    ].join("\n") + "\n",
  }
}

async function withProviderTimeout(
  command: string,
  options: ShellRuntimeExecOptions,
  run: () => Promise<ShellObservation>,
): Promise<ShellObservation> {
  if (typeof options.timeout !== "number") return await run()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<ShellObservation>((resolve) => {
        timeout = setTimeout(() => resolve({
          command,
          cwd: options.cwd,
          event: "command_timed_out",
          exitCode: null,
          stderr: `[vitehub] Workspace shell command timed out after ${options.timeout}ms.`,
          stdout: "",
          timedOut: true,
        }), options.timeout)
      }),
    ])
  }
  finally {
    if (timeout) clearTimeout(timeout)
  }
}
