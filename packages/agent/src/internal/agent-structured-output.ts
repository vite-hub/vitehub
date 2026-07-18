import { ViteHubError } from "@vite-hub/runtime"

import { toAgentRunResult } from "../agent-output.ts"

import type { AgentOutputDefinition } from "../types.ts"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"

const agentOutputErrorMessages = {
  AGENT_OUTPUT_INVALID_JSON: "[vitehub] Agent output is not valid JSON.",
  AGENT_OUTPUT_SCHEMA_INVALID: "[vitehub] Agent output failed schema validation.",
} as const

export type AgentOutputValidationErrorCode = keyof typeof agentOutputErrorMessages
export type AgentOutputValidationErrorOptions = ErrorOptions

export class AgentOutputValidationError extends ViteHubError<AgentOutputValidationErrorCode> {
  constructor(code: AgentOutputValidationErrorCode, options: AgentOutputValidationErrorOptions = {}) {
    if (!Object.hasOwn(agentOutputErrorMessages, code)) {
      throw new TypeError("[vitehub] AgentOutputValidationError requires a known agent output error code.")
    }
    super(code, agentOutputErrorMessages[code], { cause: options.cause, retryable: false })
    this.name = "AgentOutputValidationError"
  }
}

function stripJsonFence(value: string): string {
  const match = value.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)
  return match?.[1]?.trim() || value.trim()
}

function jsonValueFromResult(result: unknown): unknown {
  const directText = result && typeof result === "object" && "text" in result
    ? (result as { text?: unknown }).text
    : undefined
  const text = typeof directText === "string" && directText ? directText : toAgentRunResult(result).text
  if (text === undefined) return result

  try {
    return JSON.parse(stripJsonFence(text))
  }
  catch (cause) {
    throw new AgentOutputValidationError(
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

export async function validateAgentOutput<TOutput>(
  output: AgentOutputDefinition<TOutput>,
  result: unknown,
  options: { allowMaterializedObject?: boolean } = {},
): Promise<TOutput> {
  if (options.allowMaterializedObject && result !== null && typeof result === "object") {
    const prototype = Object.getPrototypeOf(result)
    if (prototype === Object.prototype || prototype === null) {
      const directValidation = await output.schema["~standard"].validate(result)
      if (!directValidation.issues?.length && "value" in directValidation) return directValidation.value
    }
  }
  const value = jsonValueFromResult(result)
  const validation = await output.schema["~standard"].validate(value)
  if (validation.issues?.length) {
    throw new AgentOutputValidationError(
      "AGENT_OUTPUT_SCHEMA_INVALID",
      { cause: new Error(formatIssues(validation.issues)) },
    )
  }
  if (!("value" in validation)) {
    throw new AgentOutputValidationError(
      "AGENT_OUTPUT_SCHEMA_INVALID",
    )
  }
  return validation.value
}

function supportsJsonSchema(schema: StandardSchemaV1): schema is StandardSchemaV1 & StandardJSONSchemaV1 {
  return typeof (schema["~standard"] as { jsonSchema?: unknown }).jsonSchema === "object"
    && typeof (schema["~standard"] as { jsonSchema?: { input?: unknown } }).jsonSchema?.input === "function"
}

export function agentOutputInstructions(output: AgentOutputDefinition | undefined): string | undefined {
  if (!output) return
  let jsonSchema: Record<string, unknown> | undefined
  if (supportsJsonSchema(output.schema)) {
    try {
      jsonSchema = output.schema["~standard"].jsonSchema.input({ target: "draft-07" })
    }
    catch {}
  }
  return [
    "Return only one valid JSON value for the configured Agent output. Do not wrap it in Markdown or add commentary.",
    ...(jsonSchema ? ["The JSON value must match this schema:", "```json", JSON.stringify(jsonSchema, null, 2), "```"] : []),
  ].join("\n")
}
