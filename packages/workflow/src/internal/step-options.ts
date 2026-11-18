import { readFile } from "node:fs/promises"

import { workflowErrorDiagnostics } from "../error-diagnostics.ts"
import { resolveWorkflowStepOptions } from "../runtime/execute.ts"

import type { WorkflowStepOptions } from "../types.ts"

const optionNames = ["retries", "timeout"] as const

/**
 * Reads the `retries` and `timeout` exports of a step file from its source, without running it. The build checks them,
 * and writes them into the Vercel step, which cannot import the step file in the Workflow VM.
 */
export async function readWorkflowStepOptions(file: string): Promise<WorkflowStepOptions> {
  const source = await readFile(file, "utf8")
  // Most step files have no options, so they skip the parser.
  if (!/\b(?:retries|timeout)\b/.test(source)) return {}
  const { dynamic, exportNames, scanModule, staticValue } = await import("@vite-hub/internal/build/scan-module")
  const exported = optionNames.filter(name => exportNames(source, file).includes(name))
  if (!exported.length) return {}

  const values: Record<string, unknown> = {}
  for (const statement of scanModule(source, file).program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.declaration?.type !== "VariableDeclaration") continue
    for (const declarator of statement.declaration.declarations) {
      if (declarator.id.type !== "Identifier" || !declarator.init) continue
      const value = staticValue(declarator.init)
      if (value !== dynamic) values[declarator.id.name] = value
    }
  }
  const options: WorkflowStepOptions = {}
  for (const name of exported) {
    if (!Object.hasOwn(values, name)) throw workflowErrorDiagnostics.WORKFLOW_STEP_OPTIONS_NOT_STATIC({ file, option: name })
    Object.assign(options, { [name]: values[name] })
  }
  resolveWorkflowStepOptions(file, options)
  return options
}
