import { analyzeShellCommand } from "../command/analyze.ts"

import type {
  CreateShellRuntimeOptions,
  CreateShellSessionOptions,
  ShellExecutionProvider,
  ShellObservation,
  ShellProcess,
  ShellRuntime,
  ShellRuntimeExecOptions,
  ShellSession,
  ShellSessionPolicy,
} from "./types.ts"

function applyOutputLimit(result: ShellObservation, maxLength?: number): ShellObservation {
  if (!maxLength) return result
  const next = { ...result, maxOutputLength: maxLength }
  let truncated = false
  if (next.stdout.length > maxLength) {
    next.stdout = `${next.stdout.slice(0, maxLength)}\n[output truncated to ${maxLength} characters]\n`
    truncated = true
  }
  if (next.stderr.length > maxLength) {
    next.stderr = `${next.stderr.slice(0, maxLength)}\n[output truncated to ${maxLength} characters]\n`
    truncated = true
  }
  return truncated ? { ...next, outputTruncated: true } : next
}

function createPolicyObservation(command: string, cwd: string | undefined, message: string): ShellObservation {
  return {
    command,
    cwd,
    event: "policy_denied",
    exitCode: 126,
    stderr: message.endsWith("\n") ? message : `${message}\n`,
    stdout: "",
  }
}

const shellSessionDisposedMessage = "[vitehub] Shell session is disposed."
const shellSessionStopFailureMessage = "[vitehub] Shell session failed to stop multiple background processes."

class RuntimeShellSession implements ShellSession {
  readonly boundary
  readonly policy: ShellSessionPolicy
  #disposed = false
  #disposeTask: Promise<ShellObservation> | undefined
  #processes = new Set<ShellProcess>()
  #starts = new Set<Promise<void>>()
  #shellCalls = 0

  constructor(
    private readonly provider: ShellExecutionProvider,
    policy: ShellSessionPolicy,
    private readonly env?: Record<string, string>,
  ) {
    this.boundary = provider.boundary
    this.policy = policy
  }

  async analyze(command: string, options?: Parameters<ShellSession["analyze"]>[1]) {
    return await (this.provider.analyze ?? analyzeShellCommand)(command, options)
  }

  async exec(command: string, options: ShellRuntimeExecOptions = {}) {
    if (this.#disposed) {
      return createPolicyObservation(command, options.cwd, shellSessionDisposedMessage)
    }
    if (typeof this.policy.maxShellCalls === "number" && this.#shellCalls >= this.policy.maxShellCalls) {
      return createPolicyObservation(
        command,
        options.cwd,
        `[vitehub] Shell session command budget exhausted after ${this.policy.maxShellCalls} calls. The Shell Session policy limits command calls for this run.`,
      )
    }

    this.#shellCalls += 1
    const started = Date.now()
    const result = await this.provider.exec(command, {
      ...options,
      env: { ...this.env, ...options.env },
      timeout: options.timeout ?? this.policy.timeout,
    })

    return applyOutputLimit({
      ...result,
      command: result.command ?? command,
      cwd: result.cwd ?? options.cwd,
      durationMs: result.durationMs ?? Date.now() - started,
      event: result.timedOut ? "command_timed_out" : result.event,
    }, this.policy.maxOutputLength)
  }

  async startProcess(command: string, options: ShellRuntimeExecOptions = {}) {
    if (this.#disposed) throw new Error(shellSessionDisposedMessage)
    if (!this.provider.startProcess || !this.boundary.processes.background) {
      throw new Error("[vitehub] Shell provider does not support long-running processes.")
    }
    if (typeof this.policy.maxProcesses === "number" && this.#processes.size >= this.policy.maxProcesses) {
      throw new Error(`[vitehub] Shell session process budget exhausted after ${this.policy.maxProcesses} processes.`)
    }
    let resolveOwnership!: () => void
    let rejectOwnership!: (reason: unknown) => void
    const ownership = new Promise<void>((resolve, reject) => {
      resolveOwnership = resolve
      rejectOwnership = reject
    })
    this.#starts.add(ownership)
    void ownership.then(
      () => this.#starts.delete(ownership),
      () => this.#starts.delete(ownership),
    )
    let process: ShellProcess
    try {
      process = await this.provider.startProcess(command, {
        ...options,
        env: { ...this.env, ...options.env },
        timeout: options.timeout ?? this.policy.timeout,
      })
    }
    catch (error) {
      resolveOwnership()
      throw error
    }
    let stopTask: Promise<ShellObservation> | undefined
    let trackedProcess: ShellProcess
    const stop = () => stopTask ??= Promise.resolve().then(() => process.stop()).finally(() => {
      this.#processes.delete(trackedProcess)
    })
    trackedProcess = { ...process, stop }
    if (this.#disposed) {
      try {
        await stop()
      }
      catch (error) {
        rejectOwnership(error)
        throw new AggregateError(
          [new Error(shellSessionDisposedMessage), error],
          "[vitehub] Shell session was disposed while starting a background process, and stopping it failed.",
        )
      }
      resolveOwnership()
      throw new Error(shellSessionDisposedMessage)
    }
    this.#processes.add(trackedProcess)
    resolveOwnership()
    return trackedProcess
  }

  async listProcesses() {
    return [...this.#processes.values()]
  }

  dispose() {
    this.#disposed = true
    return this.#disposeTask ??= (async () => {
      const pendingStarts = [...this.#starts]
      this.#starts.clear()
      const processes = [...this.#processes.values()]
      this.#processes.clear()
      const [starts, results] = await Promise.all([
        Promise.allSettled(pendingStarts),
        Promise.allSettled(processes.map(process => process.stop())),
      ])
      const failures = [...starts, ...results]
        .flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, shellSessionStopFailureMessage)
      return {
        event: "session_disposed" as const,
        exitCode: null,
        stderr: "",
        stdout: "",
      }
    })()
  }
}

export function createShellRuntime(options: CreateShellRuntimeOptions): ShellRuntime {
  const { provider } = options
  const policy = options.policy ?? {}
  return {
    boundary: provider.boundary,
    createSession(sessionOptions: CreateShellSessionOptions = {}) {
      return new RuntimeShellSession(provider, { ...policy, ...sessionOptions.policy }, sessionOptions.env)
    },
    async exec(command: string, execOptions: ShellRuntimeExecOptions = {}) {
      const session = new RuntimeShellSession(provider, policy)
      try {
        return await session.exec(command, execOptions)
      }
      finally {
        await session.dispose()
      }
    },
  }
}
