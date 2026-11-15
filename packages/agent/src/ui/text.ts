import { applySpecStreamPatch, getByPath, parseSpecStreamLine, type SpecStreamLine } from "@json-render/core"

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
  const problem = pointerProblem("path", patch.path) ?? (patch.from === undefined ? undefined : pointerProblem("from", patch.from))
  if (problem) return problem
  if (patch.op === "move" && typeof patch.from === "string") {
    // json-render treats both "" and "/" as the root pointer.
    const segments = (pointer: string) => pointer === "" || pointer === "/" ? [] : pointer.split("/").slice(1).map(segment => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    const from = segments(patch.from)
    const path = segments(patch.path)
    if (path.length > from.length && from.every((key, index) => path[index] === key)) return "A move cannot put a value inside itself."
  }
  return undefined
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
      // Copy the JSON value before inserting it, including when the destination is inside the source.
      const applied = patch.op === "copy" && patch.from
        ? { op: "add" as const, path: patch.path, value: structuredClone(getByPath(spec, patch.from)) }
        : patch
      applySpecStreamPatch(spec, applied)
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
