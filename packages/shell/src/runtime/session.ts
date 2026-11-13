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
import { shellErrorDiagnostics } from "../error-diagnostics.ts"

function applyOutputLimit(result: ShellObservation, maxLength?: number): ShellObservation {
  const limit = normalizeLimit(maxLength)
  if (limit === undefined) return result
  const next: ShellObservation = {
    command: result.command,
    cwd: result.cwd,
    durationMs: result.durationMs,
    event: result.event,
    exitCode: result.exitCode,
    maxOutputLength: limit,
    outputTruncated: result.outputTruncated,
    stderr: result.stderr,
    stdout: result.stdout,
    timedOut: result.timedOut,
    workspaceGuardrail: result.workspaceGuardrail,
  }
  let truncated = false
  if (next.stdout.length > limit) {
    next.stdout = `${next.stdout.slice(0, limit)}\n[output truncated to ${limit} characters]\n`
    truncated = true
  }
  if (next.stderr.length > limit) {
    next.stderr = `${next.stderr.slice(0, limit)}\n[output truncated to ${limit} characters]\n`
    truncated = true
  }
  return truncated ? { ...next, outputTruncated: true } : next
}

function normalizeLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (value === Number.POSITIVE_INFINITY) return undefined
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/** A per-call limit can only lower the policy limit. */
function lowerLimit(requested: number | undefined, policy: number | undefined): number | undefined {
  const call = normalizeLimit(requested)
  const bound = normalizeLimit(policy)
  if (call === undefined) return bound
  if (bound === undefined) return call
  return Math.min(call, bound)
}

function limitOutputOptions(options: ShellRuntimeExecOptions, policy: ShellSessionPolicy): ShellRuntimeExecOptions {
  const maxOutputLength = lowerLimit(options.maxOutputLength, policy.maxOutputLength)
  let stdoutRemaining = maxOutputLength
  let stderrRemaining = maxOutputLength
  const limitedCallback = (callback: ((data: string) => void) | undefined, remaining: () => number | undefined, consume: (value: number) => void) =>
    callback && ((data: string) => {
      const limit = remaining()
      if (limit === undefined) return callback(data)
      if (limit <= 0) return
      const chunk = data.slice(0, limit)
      consume(chunk.length)
      if (chunk) callback(chunk)
    })
  return {
    ...options,
    maxOutputLength,
    timeout: lowerLimit(options.timeout, policy.timeout),
    onStdout: limitedCallback(options.onStdout, () => stdoutRemaining, value => { stdoutRemaining = Math.max(0, (stdoutRemaining ?? 0) - value) }),
    onStderr: limitedCallback(options.onStderr, () => stderrRemaining, value => { stderrRemaining = Math.max(0, (stderrRemaining ?? 0) - value) }),
  }
}

function createTimeoutObservation(command: string, cwd: string | undefined, timeout: number): ShellObservation {
  return {
    command,
    cwd,
    event: "command_timed_out",
    exitCode: null,
    stderr: `[vitehub] Shell command timed out after ${timeout}ms.\n`,
    stdout: "",
    timedOut: true,
  }
}

/** Race the provider against the timeout, then abort the provider work. */
async function execWithRuntimeTimeout(
  provider: ShellExecutionProvider,
  command: string,
  options: ShellRuntimeExecOptions,
  timeout: number,
): Promise<ShellObservation> {
  const controller = new AbortController()
  const running = provider.exec(command, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
  })
  // The provider may reject after the timeout aborts it. That late result is not observed.
  running.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<ShellObservation>((resolve) => {
    timer = setTimeout(() => {
      resolve(createTimeoutObservation(command, options.cwd, timeout))
      controller.abort()
    }, timeout)
  })
  try {
    return await Promise.race([running, timedOut])
  }
  finally {
    clearTimeout(timer)
  }
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

class RuntimeShellSession implements ShellSession {
  readonly boundary
  readonly policy: ShellSessionPolicy
  #disposed = false
  #disposeTask: Promise<ShellObservation> | undefined
  #processes = new Set<ShellProcess>()
  #starts = new Set<Promise<void>>()
  #cancelStarts = new Set<(error: Error) => void>()
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
    return await (this.provider.analyze ?? analyzeShellCommand).call(this.provider, command, options)
  }

  async exec(command: string, options: ShellRuntimeExecOptions = {}) {
    if (this.#disposed) {
      return createPolicyObservation(command, options.cwd, shellSessionDisposedMessage)
    }
    // Count every attempted shell invocation against the shared Invocation budget,
    // including calls rejected by the per-session shell cap below, unless the caller already charged it.
    if (!options.budgetCharged) options.budget?.recordToolCall(new TextEncoder().encode(command).byteLength)
    if (typeof this.policy.maxShellCalls === "number" && this.#shellCalls >= this.policy.maxShellCalls) {
      return createPolicyObservation(
        command,
        options.cwd,
        `[vitehub] Shell session command budget exhausted after ${this.policy.maxShellCalls} calls. The Shell Session policy limits command calls for this run.`,
      )
    }

    this.#shellCalls += 1
    const started = Date.now()
    options = limitOutputOptions(options, this.policy)
    const maxOutputLength = options.maxOutputLength
    const signal = options.budget && options.signal && options.signal !== options.budget.signal
      ? AbortSignal.any([options.signal, options.budget.signal])
      : options.budget?.signal ?? options.signal
    const execOptions = {
      ...options,
      env: { ...this.env, ...options.env },
      maxOutputLength,
      signal,
    }
    const result = this.boundary.timeout.enforcedBy === "runtime" && options.timeout !== undefined
      ? await execWithRuntimeTimeout(this.provider, command, execOptions, options.timeout)
      : await this.provider.exec(command, execOptions)
    options.budget?.recordOutputBytes(new TextEncoder().encode(result.stdout).byteLength + new TextEncoder().encode(result.stderr).byteLength)

    const timedOut = result.timedOut
    return applyOutputLimit({
      command: result.command ?? command,
      cwd: result.cwd ?? options.cwd,
      durationMs: result.durationMs ?? Date.now() - started,
      event: timedOut ? "command_timed_out" : result.event,
      exitCode: result.exitCode,
      maxOutputLength: result.maxOutputLength,
      outputTruncated: result.outputTruncated,
      stderr: result.stderr,
      stdout: result.stdout,
      timedOut,
      workspaceGuardrail: result.workspaceGuardrail,
    }, maxOutputLength)
  }

  async startProcess(command: string, options: ShellRuntimeExecOptions = {}) {
    if (this.#disposed) throw shellErrorDiagnostics.SHELL_R0008({ message: shellSessionDisposedMessage })
    if (!this.provider.startProcess || !this.boundary.processes.background) {
      throw shellErrorDiagnostics.SHELL_R0009({ message: "[vitehub] Shell provider does not support long-running processes." })
    }
    if (!options.budgetCharged) options.budget?.recordToolCall(new TextEncoder().encode(command).byteLength)
    const maxProcesses = this.policy.maxProcesses
    if (maxProcesses !== undefined && this.#processes.size + this.#starts.size >= maxProcesses) {
      throw shellErrorDiagnostics.SHELL_R0010({ message: `[vitehub] Shell session process budget exhausted after ${this.policy.maxProcesses} processes.` })
    }
    options = limitOutputOptions(options, this.policy)
    const signal = options.budget && options.signal && options.signal !== options.budget.signal
      ? AbortSignal.any([options.signal, options.budget.signal])
      : options.budget?.signal ?? options.signal
    let finishStart!: () => void
    const start = new Promise<void>((resolve) => {
      finishStart = resolve
    })
    this.#starts.add(start)
    void start.finally(() => this.#starts.delete(start))

    // A runtime timeout counts from the start call, so a slow or stuck provider startup is bounded too.
    const timeout = this.boundary.timeout.enforcedBy === "runtime" ? options.timeout : undefined
    const controller = timeout === undefined ? undefined : new AbortController()
    let stop: (() => Promise<ShellObservation>) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelStart!: (error: Error) => void
    const cancelled = new Promise<never>((_, reject) => {
      cancelStart = (error) => {
        controller?.abort(error)
        reject(error)
      }
    })
    if (timeout !== undefined) {
      timer = setTimeout(() => {
        if (stop) stop().catch(() => {})
        else cancelStart(shellErrorDiagnostics.SHELL_R0024({ message: `[vitehub] Shell process start timed out after ${timeout}ms.` }))
      }, timeout)
      this.#cancelStarts.add(cancelStart)
    }
    let starting: Promise<ShellProcess> | undefined
    let started: ShellProcess
    try {
      starting = this.provider.startProcess(command, {
        ...options,
        signal: controller ? (signal ? AbortSignal.any([signal, controller.signal]) : controller.signal) : signal,
        env: { ...this.env, ...options.env },
      })
      started = await (controller ? Promise.race([starting, cancelled]) : starting)
    }
    catch (error) {
      clearTimeout(timer)
      finishStart()
      // The provider may still return a handle after the runtime gave up on it. Stop that late process.
      if (controller?.signal.aborted) void starting?.then(late => late.stop()).catch(() => {})
      throw error
    }
    finally {
      this.#cancelStarts.delete(cancelStart)
    }

    let stopTask: Promise<ShellObservation> | undefined
    let trackedProcess: ShellProcess
    stop = () => {
      clearTimeout(timer)
      if (stopTask) return stopTask
      stopTask = Promise.resolve().then(() => started.stop()).then(
        result => {
          this.#processes.delete(trackedProcess)
          return applyOutputLimit(result, options.maxOutputLength)
        },
        error => {
          stopTask = undefined
          throw error
        },
      )
      return stopTask
    }
    trackedProcess = {
      get id() { return started.id },
      get command() { return started.command },
      get cwd() { return started.cwd },
      stop,
    }
    this.#processes.add(trackedProcess)
    finishStart()
    if (this.#disposed) {
      try {
        await trackedProcess.stop()
      }
      catch (error) {
        throw new AggregateError(
          [shellErrorDiagnostics.SHELL_R0011({ message: shellSessionDisposedMessage }), error],
          "[vitehub] Shell session was disposed while starting a background process, and stopping it failed.",
        )
      }
      throw shellErrorDiagnostics.SHELL_R0012({ message: shellSessionDisposedMessage })
    }
    return trackedProcess
  }

  async listProcesses() {
    return [...this.#processes]
  }

  dispose() {
    this.#disposed = true
    if (this.#disposeTask) return this.#disposeTask
    this.#disposeTask = (async () => {
      // A runtime-timed start stops waiting for its provider now. Its late handle is stopped when it arrives.
      for (const cancel of this.#cancelStarts) cancel(shellErrorDiagnostics.SHELL_R0012({ message: shellSessionDisposedMessage }))
      await Promise.all(this.#starts)
      const failures: unknown[] = []
      for (const process of [...this.#processes].reverse()) {
        try {
          await process.stop()
        }
        catch (error) {
          failures.push(error)
        }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "[vitehub] Shell session failed to stop multiple background processes.",
        )
      }
      return {
        event: "session_disposed" as const,
        exitCode: null,
        stderr: "",
        stdout: "",
      }
    })().catch((error) => {
      this.#disposeTask = undefined
      throw error
    })
    return this.#disposeTask
  }
}

export function createShellRuntime(options: CreateShellRuntimeOptions): ShellRuntime {
  const { provider } = options
  const policy = { ...(options.policy ?? {}) }
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
