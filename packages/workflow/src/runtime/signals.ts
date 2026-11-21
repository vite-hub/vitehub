import type { WorkflowDriver } from "../types.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"

/** Where the run that made a signal waits: in a durable provider, or in the memory of this process. */
export type WorkflowSignalHost = Exclude<WorkflowDriver, "vercel"> | "inline"

/** What a signal token names. ViteHub makes the token from it, so the token is the same on each replay. */
export interface WorkflowSignalAddress {
  host: WorkflowSignalHost
  /** The run ID. */
  run: string
  /** The wait name, such as `signal-1`. */
  signal: string
  workflow: string
}

const tokenPrefix = "vhsig1."
const hosts: ReadonlySet<string> = new Set<WorkflowSignalHost>(["cloudflare", "inline", "openworkflow"])

function toBase64Url(text: string): string {
  let binary = ""
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function fromBase64Url(value: string): string {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"))
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
}

export function createWorkflowSignalToken({ host, run, signal, workflow }: WorkflowSignalAddress): string {
  return `${tokenPrefix}${toBase64Url(JSON.stringify([host, workflow, run, signal]))}`
}

/** The address in a token of `context.createSignal()`, or undefined for any other string. */
export function readWorkflowSignalToken(token: string): WorkflowSignalAddress | undefined {
  if (!token.startsWith(tokenPrefix)) return undefined
  let value: unknown
  try {
    value = JSON.parse(fromBase64Url(token.slice(tokenPrefix.length)))
  }
  catch {
    return undefined
  }
  if (!Array.isArray(value) || value.length !== 4 || !value.every(part => typeof part === "string" && part !== "")) return undefined
  const [host, workflow, run, signal] = value
  if (!hosts.has(host)) return undefined
  // SAFETY: The set check above accepts only the names of WorkflowSignalHost.
  return { host: host as WorkflowSignalHost, run, signal, workflow }
}

interface InlineSignal {
  resolve?: (value: unknown) => void
  sent?: { value: unknown }
}

const inlineSignals = new Map<string, InlineSignal>()

/** Adds the inline signal of `token`, so a `resumeWorkflow()` call before the wait keeps its value. */
export function openInlineWorkflowSignal(token: string): void {
  if (!inlineSignals.has(token)) inlineSignals.set(token, {})
}

/** Forgets the inline signals of a run that ended. A later `resumeWorkflow()` call fails with `WORKFLOW_SIGNAL_NOT_WAITING`. */
export function closeInlineWorkflowSignals(tokens: Iterable<string>): void {
  for (const token of tokens) inlineSignals.delete(token)
}

/** Waits in memory for the value of `resumeWorkflow(token, value)`. */
export async function waitForInlineWorkflowSignal(token: string): Promise<unknown> {
  const entry = inlineSignals.get(token) ?? {}
  inlineSignals.set(token, entry)
  if (entry.sent) {
    inlineSignals.delete(token)
    return entry.sent.value
  }
  return await new Promise((resolve) => {
    entry.resolve = (value) => {
      inlineSignals.delete(token)
      resolve(value)
    }
  })
}

/** Sends `value` to the inline signal of `token`. Fails when no run of this process has the signal open. */
export function resumeInlineWorkflowSignal(token: string, address: WorkflowSignalAddress, value: unknown): void {
  const entry = inlineSignals.get(token)
  if (!entry || entry.sent) throw workflowErrorDiagnostics.WORKFLOW_SIGNAL_NOT_WAITING({ run: address.run })
  if (entry.resolve) entry.resolve(value)
  else entry.sent = { value }
}

export function resetInlineWorkflowSignals(): void {
  inlineSignals.clear()
}
