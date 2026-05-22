export type ShellObservationEvent =
  | "command_finished"
  | "command_timed_out"
  | "policy_denied"
  | "session_disposed"

export interface ShellRuntimeExecOptions {
  cwd?: string
  env?: Record<string, string>
  onStderr?: (data: string) => void
  onStdout?: (data: string) => void
  stdin?: string
  timeout?: number
}

export interface ShellObservation {
  command?: string
  cwd?: string
  durationMs?: number
  event: ShellObservationEvent
  exitCode: number | null
  maxOutputLength?: number
  outputTruncated?: boolean
  stderr: string
  stdout: string
  timedOut?: boolean
}

export interface ShellAnalyzeOptions {
  maxInputBytes?: number
  timeoutMs?: number
}

export interface ShellAnalyzeResult {
  commands?: string[]
  error?: string
  hasCommandSubstitution?: boolean
  hasHeredocs?: boolean
  hasPipelines?: boolean
  hasRedirects?: boolean
  ok: boolean
  parser: "sh-syntax"
}

export interface ShellSessionPolicy {
  maxOutputLength?: number
  maxShellCalls?: number
  maxProcesses?: number
  timeout?: number
}

export interface ShellBoundary {
  cwd: boolean
  env: boolean
  filesystem: {
    mountPoint?: string
    writable: boolean
  }
  network: boolean | "unknown"
  processes: {
    background: boolean
    interactive: boolean
  }
  streaming: boolean
  timeout: {
    enforcedBy: "provider" | "runtime" | "unsupported"
    supported: boolean
  }
}

export interface ShellProcess {
  id: string
  command: string
  cwd?: string
  stop(): Promise<ShellObservation>
}

export interface ShellExecutionProvider {
  analyze?: (command: string, options?: ShellAnalyzeOptions) => Promise<ShellAnalyzeResult>
  boundary: ShellBoundary
  exec(command: string, options?: ShellRuntimeExecOptions): Promise<ShellObservation>
  startProcess?: (command: string, options?: ShellRuntimeExecOptions) => Promise<ShellProcess>
}

export interface ShellSession {
  analyze(command: string, options?: ShellAnalyzeOptions): Promise<ShellAnalyzeResult>
  boundary: ShellBoundary
  dispose(): Promise<ShellObservation>
  exec(command: string, options?: ShellRuntimeExecOptions): Promise<ShellObservation>
  listProcesses(): Promise<ShellProcess[]>
  policy: ShellSessionPolicy
  startProcess(command: string, options?: ShellRuntimeExecOptions): Promise<ShellProcess>
}

export interface ShellRuntime {
  boundary: ShellBoundary
  createSession(options?: CreateShellSessionOptions): ShellSession
  exec(command: string, options?: ShellRuntimeExecOptions): Promise<ShellObservation>
}

export interface CreateShellRuntimeOptions {
  provider: ShellExecutionProvider
  policy?: ShellSessionPolicy
}

export interface CreateShellSessionOptions {
  env?: Record<string, string>
  policy?: ShellSessionPolicy
}
