import { getViteHubErrorShape, ViteHubError } from "@vite-hub/runtime"

import { toAgentRunResult } from "../agent-output.ts"

import type { AgentOutputDefinition } from "../types.ts"
import type { StandardSchemaV1 } from "@standard-schema/spec"

const agentOutputErrorMessages = {
  AGENT_OUTPUT_INVALID_JSON: "[vitehub] Agent output is not valid JSON.",
  AGENT_OUTPUT_SCHEMA_INVALID: "[vitehub] Agent output failed schema validation.",
} as const

type AgentOutputValidationErrorCode = keyof typeof agentOutputErrorMessages

function agentOutputValidationError(code: AgentOutputValidationErrorCode, options?: ErrorOptions) {
  if (typeof code !== "string" || !Object.hasOwn(agentOutputErrorMessages, code)) {
    throw new TypeError("[vitehub] Agent output errors require a known code.")
  }
  return new ViteHubError(code, agentOutputErrorMessages[code], { cause: readErrorCause(options) })
}

export async function normalizeNativeAgentOutputError(output: AgentOutputDefinition | undefined, error: unknown): Promise<never> {
  const text = error && typeof error === "object" && "text" in error && typeof error.text === "string" && "name" in error && error.name === "AI_NoObjectGeneratedError" ? error.text : undefined
  if (output && text !== undefined) await validateAgentOutput(output, text)
  throw error
}

function isAgentOutputValidationError(value: unknown): boolean {
  const code = getViteHubErrorShape(value)?.code
  return code === "AGENT_OUTPUT_INVALID_JSON" || code === "AGENT_OUTPUT_SCHEMA_INVALID"
}

function readErrorCause(options: unknown): unknown {
  if ((typeof options !== "object" || options === null) && typeof options !== "function") return undefined
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
    const directText = result && typeof result === "object" && Reflect.has(result, "text")
      ? Reflect.get(result, "text")
      : undefined
    text = typeof directText === "string" && directText ? directText : toAgentRunResult(result).text
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
  return issue.path.map(segment => typeof segment === "object" ? String(segment.key) : String(segment)).join(".")
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
  if (result === null || typeof result !== "object") return false
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
  options: { allowMaterializedObject?: boolean } = {},
): Promise<TOutput> {
  if (options.allowMaterializedObject && isMaterializedObject(result)) {
    const directValidation = inspectValidation(await output.schema["~standard"].validate(result), true)
    if (directValidation) return directValidation.value
  }
  const value = jsonValueFromResult(result)
  const validation = inspectValidation(await output.schema["~standard"].validate(value))
  if (!validation) throw agentOutputValidationError("AGENT_OUTPUT_SCHEMA_INVALID")
  return validation.value
}

export function agentOutputJsonSchema(schema: StandardSchemaV1): Record<string, unknown> | undefined {
  const jsonSchema = (schema["~standard"] as { jsonSchema?: { input?: unknown } }).jsonSchema
  if (typeof jsonSchema !== "object" || typeof jsonSchema.input !== "function") return
  try {
    return jsonSchema.input({ target: "draft-07" }) as Record<string, unknown>
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
