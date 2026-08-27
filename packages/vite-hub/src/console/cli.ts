import { resolve } from "node:path"

import type { ViteHubCliCommandNamespace, ViteHubCliContext } from "@vite-hub/internal/cli"

import { consoleFixtureEnvironmentVariable, readConsoleFixture } from "./fixture.ts"

interface ConsoleDevOptions {
  command: string
  commandArgs: string[]
  fixture: string
}
const consoleDevUsage = "vitehub console dev --fixture <file> -- <command> [args...]"

function writeConsoleDevHelp(context: ViteHubCliContext): void {
  context.stdout.write(
    [
      `Usage: ${consoleDevUsage}`,
      "",
      "Start the project's normal development command with a deterministic Console fixture.",
      "The fixture must use Console fixture version 1 and is resolved from the Vite project root.",
      "",
    ].join("\n"),
  )
}

function parseConsoleDevArgs(args: string[]): ConsoleDevOptions | "help" {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return "help"
  let fixture: string | undefined
  let delimiter = -1
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      delimiter = index
      break
    }
    if (arg === "--fixture") {
      const value = args[++index]
      if (!value || value === "--") throw new TypeError("Option --fixture requires a value.")
      fixture = value
      continue
    }
    if (arg.startsWith("--fixture=")) {
      fixture = arg.slice("--fixture=".length)
      if (!fixture) throw new TypeError("Option --fixture requires a value.")
      continue
    }
    throw new TypeError(`Unknown Console dev argument: ${arg}`)
  }
  if (!fixture) throw new TypeError("Console dev requires --fixture <file>.")
  if (delimiter < 0 || !args[delimiter + 1]) {
    throw new TypeError("Console dev requires a development command after --.")
  }
  return {
    command: args[delimiter + 1]!,
    commandArgs: args.slice(delimiter + 2),
    fixture,
  }
}

export async function runConsoleDevCli(
  args: string[],
  context: ViteHubCliContext,
): Promise<number> {
  let options: ConsoleDevOptions | "help"
  try {
    options = parseConsoleDevArgs(args)
  } catch (error) {
    context.stderr.write(
      `${error instanceof Error ? error.message : error}\nUsage: ${consoleDevUsage}\n`,
    )
    return 1
  }
  if (options === "help") {
    writeConsoleDevHelp(context)
    return 0
  }
  const fixture = resolve(context.rootDir, options.fixture)
  let count: number
  try {
    count = readConsoleFixture(fixture).invocations.length
  } catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    return 1
  }
  context.stdout.write(
    `Console fixture: ${fixture} (${count} invocation${count === 1 ? "" : "s"})\n`,
  )
  try {
    const result = await context.spawn(options.command, options.commandArgs, {
      cwd: context.cwd,
      env: {
        ...context.env,
        [consoleFixtureEnvironmentVariable]: fixture,
      },
    })
    if (result.exitCode !== null) return result.exitCode
    context.stderr.write(
      `Console development command exited without a status${result.signal ? ` (${result.signal})` : ""}.\n`,
    )
    return 1
  } catch (error) {
    context.stderr.write(
      `Could not start Console development command: ${error instanceof Error ? error.message : error}\n`,
    )
    return 1
  }
}

export function createConsoleCliNamespace(): ViteHubCliCommandNamespace {
  return {
    description: "Console development workflows.",
    features: [
      {
        description: "Start a development command with saved Agent Invocation data.",
        name: "dev",
        run: runConsoleDevCli,
        usage: consoleDevUsage,
      },
    ],
    name: "console",
  }
}
