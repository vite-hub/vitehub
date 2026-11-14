import { applySpecStreamPatch, parseSpecStreamLine, type SpecStreamLine } from "@json-render/core"

import { diagnostic } from "./diagnostics.ts"
import { type SpecValidation, validateSpec, type ValidateSpecOptions } from "./validate.ts"

// A patch comes from the model. These keys would write to `Object.prototype` instead of the spec.
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"])

function pointerProblem(name: string, pointer: unknown): string | undefined {
  if (typeof pointer !== "string") return `"${name}" is not a JSON Pointer string.`
  const key = pointer.split("/").map(segment => segment.replaceAll("~1", "/").replaceAll("~0", "~")).find(segment => unsafeKeys.has(segment))
  return key === undefined ? undefined : `"${name}" uses the key "${key}".`
}

function patchProblem(patch: SpecStreamLine): string | undefined {
  return pointerProblem("path", patch.path) ?? (patch.from === undefined ? undefined : pointerProblem("from", patch.from))
}

/**
 * Builds the spec from the model's answer to `catalogPrompt()` and checks it with `validateSpec()`. The answer has one
 * JSON patch on each line. Other lines, such as text and code fences, are skipped, so an answer of the `inline` mode
 * works too. When the answer has no patches, or a patch cannot apply, the result has `AGENT_UI_SPEC_NOT_FOUND` or
 * `AGENT_UI_PATCH_INVALID`, which the app sends back to the model like the other diagnostics.
 *
 * @example
 * ```ts
 * const result = specFromText(answer, { surface: "web", catalog })
 * if (!result.valid) return { error: result.diagnostics }
 * ```
 */
export function specFromText(text: string, options: ValidateSpecOptions): SpecValidation {
  const spec: Record<string, unknown> = {}
  let patches = 0
  for (const [index, line] of text.split("\n").entries()) {
    const patch = parseSpecStreamLine(line)
    if (!patch) continue
    patches++
    const at = typeof patch.path === "string" ? patch.path : ""
    const problem = patchProblem(patch)
    if (problem) return { valid: false, diagnostics: [diagnostic("AGENT_UI_PATCH_INVALID", { line: index + 1, problem }, at)] }
    try {
      applySpecStreamPatch(spec, patch)
    }
    catch (error) {
      // json-render throws for a failed `test` and for a path through a value that is not an object.
      const message = error instanceof Error ? error.message : String(error)
      return { valid: false, diagnostics: [diagnostic("AGENT_UI_PATCH_INVALID", { line: index + 1, problem: message }, at)] }
    }
  }
  if (!patches) return { valid: false, diagnostics: [diagnostic("AGENT_UI_SPEC_NOT_FOUND", {}, "")] }
  return validateSpec(spec, options)
}
