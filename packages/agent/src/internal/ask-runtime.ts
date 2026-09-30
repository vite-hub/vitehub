import { agentDiagnostics } from "../agent-diagnostics.ts"
import { getMessageText } from "../messages.ts"
import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"
import { importServerEnvModule } from "./server-env.ts"

import type { AskAnswers, AskEntry, AskQuestion, AskQuestions } from "../ask.ts"
import type { Message } from "../messages.ts"
import type { AgentRunInput } from "../types.ts"

type Advocaat = typeof import("advocaat")
type AdvocaatQuestion = Parameters<Advocaat["ask"]>[1][string]

/** The Server Env group that `typesafeEnv()` declares. */
export const typesafeEnvGroup = "typesafe"

const typesafeEnvHint = "Declare it in the Vite config with `env: { server: { typesafe: typesafeEnv() } }` from `vite-hub/env`."

export interface AskRequestContext {
  abortSignal?: AbortSignal
  /** Passed to `useServerEnv()` so Cloudflare bindings resolve for this request. */
  event?: unknown
}

type AskStateInput = Pick<AgentRunInput, "data" | "prompt">

async function loadAdvocaat(): Promise<Advocaat> {
  try {
    return await import("advocaat")
  }
  catch (error) {
    throw agentDiagnostics.AGENT_R0928({
      message: "[vitehub] TypeSafe Jev requests require the advocaat package. Install it with: pnpm add advocaat",
      cause: error,
    })
  }
}

function unseal(value: unknown): unknown {
  return isRuntimeRecord(value) && hasRuntimeType(value.unseal, "function") ? value.unseal() : value
}

function optionalString(value: unknown): string | undefined {
  const resolved = unseal(value)
  return hasRuntimeType(resolved, "string") && resolved.trim() ? resolved.trim() : undefined
}

/** Reads `env.server.typesafe` through the generated Server Env module. */
async function typesafeOptions(context: AskRequestContext) {
  let module: Awaited<ReturnType<typeof importServerEnvModule>>
  try {
    module = await importServerEnvModule()
  }
  catch (error) {
    throw agentDiagnostics.AGENT_R0929({ message: `[vitehub] TypeSafe Jev requests read the Server Env group "${typesafeEnvGroup}", but Server Env is not available. ${typesafeEnvHint}`, cause: error })
  }
  const env = module.useServerEnv?.(context.event)
  const group = isRuntimeRecord(env) ? env[typesafeEnvGroup] : undefined
  if (!isRuntimeRecord(group)) {
    throw agentDiagnostics.AGENT_R0929({ message: `[vitehub] TypeSafe Jev requests read the Server Env group "${typesafeEnvGroup}", but it is not declared. ${typesafeEnvHint}` })
  }
  const provider = group.provider === "vercel" ? "vercel" : "typesafe"
  const apiKey = optionalString(group.apiKey)
  // Without a key, the Vercel provider lets advocaat use VERCEL_OIDC_TOKEN on Vercel.
  if (!apiKey && provider === "typesafe") {
    throw agentDiagnostics.AGENT_R0930({ message: `[vitehub] TypeSafe Jev requests require env.server.${typesafeEnvGroup}.apiKey. Set TYPESAFE_API_KEY, or use typesafeEnv({ provider: "vercel" }) with AI_GATEWAY_API_KEY.` })
  }
  const model = optionalString(group.model)
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    provider,
  } as const
}

function toEntry(value: unknown): AskEntry {
  if (value === undefined || value === null) return null
  if (hasRuntimeType(value, "string")) return value
  if (hasRuntimeType(value, "number") || hasRuntimeType(value, "boolean") || hasRuntimeType(value, "bigint")) return String(value)
  // JSON round trip drops functions and undefined values, like the request body would.
  return JSON.parse(JSON.stringify(value))
}

function invalidQuestion(name: string) {
  return agentDiagnostics.AGENT_R0931({ message: `[vitehub] Jev question "${name}" must be built with ask.choice(), ask.score(), ask.chance(), ask.if(), or ask.switch().` })
}

function validateQuestionCriteria(name: string, question: AskQuestion): void {
  if (question.type === "choice" || question.type === "switch") {
    const count = isRuntimeRecord(question.criteria) && !Array.isArray(question.criteria)
      ? Object.keys(question.criteria).length
      : 0
    if (count < 2 || count > 255) {
      throw agentDiagnostics.AGENT_R0931({ message: `[vitehub] Jev question "${name}" ${question.type} criteria must have between 2 and 255 choices.` })
    }
  }
  else if (question.type === "score") {
    const count = Array.isArray(question.criteria) ? question.criteria.length : 0
    if (count < 2 || count > 10) {
      throw agentDiagnostics.AGENT_R0931({ message: `[vitehub] Jev question "${name}" score criteria must have between 2 and 10 levels.` })
    }
  }
}

function toAdvocaatQuestion(name: string, question: AskQuestion): AdvocaatQuestion {
  switch (question.type) {
    case "chance":
      return { criteria: question.criteria, instructions: question.instructions, type: "noul" }
    case "choice":
    case "score":
    case "if":
    case "switch":
      validateQuestionCriteria(name, question)
      return question
  }
  throw invalidQuestion(name)
}

/** Jev state for a run: Invocation `data` when present, else the prompt text, else the latest user message. */
export function askState(input: AskStateInput, prompt: unknown, messages: readonly Message[]): unknown {
  // `data` is part of the Agent Run Input once `defineAgent({ data })` is available. Read it when a caller sets it.
  if ("data" in input && input.data !== undefined) return input.data
  if (hasRuntimeType(prompt, "string") && prompt.trim()) return prompt.trim()
  const latest = [...messages].reverse().find(message => message.role === "user")
  return latest ? getMessageText(latest).trim() : null
}

/** Sends every question to TypeSafe Jev in one request and returns the answers under the same keys. */
export async function askJev<const Q extends AskQuestions>(context: AskRequestContext, state: unknown, questions: Q): Promise<AskAnswers<Q>> {
  if (!isRuntimeRecord(questions) || Array.isArray(questions)) {
    throw agentDiagnostics.AGENT_R0931({ message: "[vitehub] defineAgent({ driver.ask }) must resolve to an object of Jev questions." })
  }
  const wire = Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    if (!isRuntimeRecord(question)) throw invalidQuestion(name)
    return [name, toAdvocaatQuestion(name, question)]
  }))
  const advocaat = await loadAdvocaat()
  const options = await typesafeOptions(context)
  const answers = await advocaat.ask(toEntry(state), wire, { ...options, signal: context.abortSignal })
  // SAFETY: advocaat answers under the same keys, with the answer shapes that AskAnswers describes for each question type.
  return answers as AskAnswers<Q>
}
