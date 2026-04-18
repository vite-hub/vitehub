import { spawn } from "node:child_process"

import { x } from "tinyexec"

export { getRandomPort as getFreePort } from "get-port-please"

export async function execCommand(
  command: string,
  args: string[],
  options: { cwd: string, env?: NodeJS.ProcessEnv },
): Promise<void> {
  await x(command, args, {
    nodeOptions: { cwd: options.cwd, env: options.env },
    throwOnError: true,
  })
}

export async function startCommand(
  command: string,
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
  },
): Promise<{
  exit: Promise<number>
  kill: (signal?: NodeJS.Signals) => void
  stderr: string[]
  stdout: string[]
}> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "pipe",
  })

  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout.on("data", chunk => stdout.push(String(chunk)))
  child.stderr.on("data", chunk => stderr.push(String(chunk)))

  const exit = new Promise<number>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", code => resolve(code ?? 0))
  })

  return {
    exit,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      child.kill(signal)
    },
    stderr,
    stdout,
  }
}
