#!/usr/bin/env node
import { spawn } from "node:child_process"
import { constants } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_NODE_OPTIONS = "--max-old-space-size=4096"

export function typecheckEnvironment(environment = process.env) {
  return {
    ...environment,
    ...(environment.NODE_OPTIONS === undefined ? { NODE_OPTIONS: DEFAULT_NODE_OPTIONS } : {}),
  }
}

function signalExitCode(signal) {
  return 128 + (constants.signals[signal] ?? 0)
}

export function runTypecheckPhase(command, args, environment, abortSignal) {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32"
    const child = spawn(command, args, { detached, env: environment, stdio: "inherit" })
    const onAbort = () => {
      const signal = abortSignal.reason || "SIGTERM"
      try {
        if (detached && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      }
      catch (error) {
        if (error.code !== "ESRCH") throw error
      }
    }
    if (abortSignal.aborted) onAbort()
    else abortSignal.addEventListener("abort", onAbort, { once: true })
    const cleanup = () => abortSignal.removeEventListener("abort", onAbort)
    child.once("error", (error) => {
      cleanup()
      reject(error)
    })
    child.once("close", (code, signal) => {
      cleanup()
      resolve(signal ? signalExitCode(signal) : (code ?? 1))
    })
  })
}

export async function runTypecheck(environment = process.env, execute = runTypecheckPhase) {
  const childEnvironment = typecheckEnvironment(environment)
  const vp = fileURLToPath(new URL("./bin/vp", import.meta.resolve("vite-plus/package.json")))
  const steps = [
    [process.execPath, [vp, "run", "build"]],
    [process.execPath, [vp, "run", "--filter", "vitehub-docs", "--ignore-depends-on", "typecheck"]],
    [process.execPath, ["test/run-package-task.mjs", "typecheck"]],
  ]

  const controller = new AbortController()
  const interrupt = signal => controller.abort(signal)
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    for (const [command, args] of steps) {
      const exitCode = await execute(command, args, childEnvironment, controller.signal)
      if (controller.signal.aborted) return signalExitCode(controller.signal.reason)
      if (exitCode !== 0) return exitCode
    }
    return 0
  }
  finally {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    process.exitCode = await runTypecheck()
  }
  catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
