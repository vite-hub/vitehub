import { getViteHubErrorShape, ViteHubError } from "@vite-hub/runtime"

import { toAgentRunResult } from "../agent-output.ts"
import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"

import type { AgentOutputDefinition } from "../types.ts"
import type { StandardSchemaV1 } from "@standard-schema/spec"

const agentOutputErrorMessages = {
  AGENT_OUTPUT_INVALID_JSON: "[vitehub] Agent output is not valid JSON.",
  AGENT_OUTPUT_SCHEMA_INVALID: "[vitehub] Agent output failed schema validation.",
} as const

type AgentOutputValidationErrorCode = keyof typeof agentOutputErrorMessages

const agentOutputValidationMemoSymbol = Symbol("vitehub.agent.output-validation-memo")

export const agentOutputRepairSymbol = Symbol.for("vitehub.agent.output-repair")
export const agentOutputUsageReadySymbol = Symbol.for("vitehub.agent.output-usage-ready")

export interface AgentOutputUsageLifecycle {
  complete: () => void
  drive?: () => PromiseLike<unknown>
}

function agentOutputValidationError(code: AgentOutputValidationErrorCode, options?: ErrorOptions) {
  if (!Object.hasOwn(agentOutputErrorMessages, code)) {
    throw new TypeError("[vitehub] Agent output errors require a known code.")
  }
  return new ViteHubError(code, agentOutputErrorMessages[code], { cause: readErrorCause(options) })
}

export async function normalizeNativeAgentOutputError(output: AgentOutputDefinition | undefined, error: unknown): Promise<never> {
  const failure = await nativeAgentOutputValidationFailure(output, error)
  if (failure) throw failure.error
  throw error
}

export async function nativeAgentOutputValidationFailure(
  output: AgentOutputDefinition | undefined,
  error: unknown,
): Promise<{ error: Error, text: string } | undefined> {
  const text = isRuntimeRecord(error) && hasRuntimeType(error.text, "string") && error.name === "AI_NoObjectGeneratedError" ? error.text : undefined
  if (!output || text === undefined) return
  try {
    await validateAgentOutput(output, text)
  }
  catch (validationError) {
    if (isAgentOutputValidationError(validationError)) {
      // SAFETY: ViteHub validation failures are created as Error instances by agentOutputValidationError.
      return { error: validationError as Error, text }
    }
    throw validationError
  }
}

export function isAgentOutputValidationError(value: unknown): boolean {
  const code = getViteHubErrorShape(value)?.code
  return code === "AGENT_OUTPUT_INVALID_JSON" || code === "AGENT_OUTPUT_SCHEMA_INVALID"
}

function readErrorCause(options: unknown): unknown {
  if (!isRuntimeRecord(options) && !hasRuntimeType(options, "function")) return undefined
  try {
    return Reflect.get(options, "cause")
  }
  catch {
    return undefined
  }
}

function stripJsonFence(value: string): string {
  const match = value.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)
  return match?.[1]?.trim() || value.trim()
}

function jsonValueFromResult(result: unknown): unknown {
  let text: string | undefined
  try {
    const directText = isRuntimeRecord(result) && Reflect.has(result, "text")
      ? Reflect.get(result, "text")
      : undefined
    text = hasRuntimeType(directText, "string") && directText ? directText : toAgentRunResult(result).text
  }
  catch (cause) {
    throw agentOutputValidationError("AGENT_OUTPUT_INVALID_JSON", { cause })
  }
  if (text === undefined) return result

  try {
    return JSON.parse(stripJsonFence(text))
  }
  catch (cause) {
    throw agentOutputValidationError(
      "AGENT_OUTPUT_INVALID_JSON",
      { cause },
    )
  }
}

function issuePath(issue: StandardSchemaV1.Issue): string | undefined {
  if (!issue.path?.length) return
  return issue.path.map(segment => isRuntimeRecord(segment) ? String(segment.key) : String(segment)).join(".")
}

function formatIssues(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues.map((issue) => {
    const path = issuePath(issue)
    return path ? `${path}: ${issue.message}` : issue.message
  }).join("; ")
}

function inspectValidation<T>(
  validation: StandardSchemaV1.Result<T>,
  allowIssues = false,
): { value: T } | undefined {
  try {
    const issues = validation.issues
    if (issues !== undefined) {
      if (!Array.isArray(issues)) throw new TypeError("[vitehub] Standard Schema returned invalid issues.")
      if (issues.length > 0) {
        if (allowIssues) return
        throw agentOutputValidationError("AGENT_OUTPUT_SCHEMA_INVALID", { cause: new Error(formatIssues(issues)) })
      }
    }
    if (!("value" in validation)) throw new TypeError("[vitehub] Standard Schema returned no value.")
    return { value: validation.value }
  }
  catch (cause) {
    if (isAgentOutputValidationError(cause)) throw cause
    throw agentOutputValidationError("AGENT_OUTPUT_SCHEMA_INVALID", { cause })
  }
}

function isMaterializedObject(result: unknown): boolean {
  if (!isRuntimeRecord(result)) return false
  try {
    const prototype = Object.getPrototypeOf(result)
    return prototype === Object.prototype || prototype === null
  }
  catch (cause) {
    throw agentOutputValidationError("AGENT_OUTPUT_INVALID_JSON", { cause })
  }
}

export async function validateAgentOutput<TOutput>(
  output: AgentOutputDefinition<TOutput>,
  result: unknown,
  options: { allowMaterializedObject?: boolean, reuseNextValidation?: boolean } = {},
): Promise<TOutput> {
  if (result && hasRuntimeType(result, "object")) {
    let memo: unknown
    try {
      memo = Reflect.get(result, agentOutputValidationMemoSymbol)
      Reflect.deleteProperty(result, agentOutputValidationMemoSymbol)
    }
    catch {
      memo = undefined
    }
    if (isRuntimeRecord(memo)
      && memo.schema === output.schema
      && memo.allowMaterializedObject === Boolean(options.allowMaterializedObject)) {
      return memo.value as TOutput
    }
  }
  let value: TOutput
  if (options.allowMaterializedObject && isMaterializedObject(result)) {
    const directValidation = inspectValidation(await output.schema["~standard"].validate(result), true)
    if (directValidation) value = directValidation.value
    else {
      const parsed = jsonValueFromResult(result)
      const validation = inspectValidation(await output.schema["~standard"].validate(parsed))
      if (!validation) throw agentOutputValidationError("AGENT_OUTPUT_SCHEMA_INVALID")
      value = validation.value
    }
  }
  else {
    const parsed = jsonValueFromResult(result)
    const validation = inspectValidation(await output.schema["~standard"].validate(parsed))
    if (!validation) throw agentOutputValidationError("AGENT_OUTPUT_SCHEMA_INVALID")
    value = validation.value
  }
  if (options.reuseNextValidation && result && hasRuntimeType(result, "object") && Object.isExtensible(result)) {
    try {
      Object.defineProperty(result, agentOutputValidationMemoSymbol, {
        configurable: true,
        value: {
          allowMaterializedObject: Boolean(options.allowMaterializedObject),
          schema: output.schema,
          value,
        },
      })
    }
    catch {
      // Non-extensible proxies can reject private validation metadata; the next boundary validates again.
    }
  }
  return value
}

export function agentOutputJsonSchema(schema: StandardSchemaV1): Record<string, unknown> | undefined {
  // SAFETY: Standard Schema exposes optional vendor metadata through its typed private namespace.
  const jsonSchema = (schema["~standard"] as { jsonSchema?: { input?: unknown } }).jsonSchema
  if (!isRuntimeRecord(jsonSchema) || !hasRuntimeType(jsonSchema.input, "function")) return
  try {
    const value = jsonSchema.input({ target: "draft-07" })
    return isRuntimeRecord(value) ? value : undefined
  }
  catch {
    return
  }
}

export function agentOutputInstructions(output: AgentOutputDefinition | undefined): string | undefined {
  if (!output) return
  const jsonSchema = agentOutputJsonSchema(output.schema)
  return [
    "Return only one valid JSON value for the configured Agent output. Do not wrap it in Markdown or add commentary.",
    ...(jsonSchema ? ["The JSON value must match this schema:", "```json", JSON.stringify(jsonSchema, null, 2), "```"] : []),
  ].join("\n")
}
