import { toAgentRunResult } from "../agent-output.ts"

import type { AgentOutputDefinition } from "../types.ts"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"

export class AgentOutputValidationError extends Error {
  readonly code: "invalid-json" | "schema-validation"

  constructor(code: AgentOutputValidationError["code"], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "AgentOutputValidationError"
    this.code = code
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
  const text = typeof directText === "string" ? directText : toAgentRunResult(result).text
  if (text === undefined) return result

  try {
    return JSON.parse(stripJsonFence(text))
  }
  catch (cause) {
    if (result !== null && typeof result === "object") return result
    throw new AgentOutputValidationError(
      "invalid-json",
      "[vitehub] Agent output is not valid JSON.",
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
): Promise<TOutput> {
  const value = jsonValueFromResult(result)
  const validation = await output.schema["~standard"].validate(value)
  if (validation.issues?.length) {
    throw new AgentOutputValidationError(
      "schema-validation",
      `[vitehub] Agent output failed schema validation: ${formatIssues(validation.issues)}.`,
    )
  }
  if (!("value" in validation)) {
    throw new AgentOutputValidationError(
      "schema-validation",
      "[vitehub] Agent output failed schema validation.",
    )
  }
  return validation.value
}

function supportsJsonSchema(schema: StandardSchemaV1): schema is StandardSchemaV1 & StandardJSONSchemaV1 {
  return typeof (schema["~standard"] as { jsonSchema?: unknown }).jsonSchema === "object"
    && typeof (schema["~standard"] as { jsonSchema?: { output?: unknown } }).jsonSchema?.output === "function"
}

export function agentOutputInstructions(output: AgentOutputDefinition | undefined): string | undefined {
  if (!output) return
  let jsonSchema: Record<string, unknown> | undefined
  if (supportsJsonSchema(output.schema)) {
    try {
      jsonSchema = output.schema["~standard"].jsonSchema.output({ target: "draft-07" })
    }
    catch {}
  }
  return [
    "Return only one valid JSON value for the configured Agent output. Do not wrap it in Markdown or add commentary.",
    ...(jsonSchema ? ["The JSON value must match this schema:", "```json", JSON.stringify(jsonSchema, null, 2), "```"] : []),
  ].join("\n")
}
