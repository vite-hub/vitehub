/**
 * Shared checks for the `extends: preset` and `extends: [preset, options]` forms. Each package keeps its own merge
 * rules; these helpers only validate the selection shape and option keys so every product reports them the same way.
 */

/** A preset selected through `extends`, with the options from the tuple form. */
export interface PresetSelection {
  preset: unknown
  /** Options from `[preset, options]`. Undefined for the bare form. */
  options?: Record<string, unknown>
}

/** Whether a value is a plain options object: an object literal or a null-prototype record. */
export function isPresetOptionsRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || Object(value) !== value || Array.isArray(value)) return false
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Preset options are untyped input; this boundary rejects callables.
  if (typeof value !== "object") return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Split `extends` into its preset and tuple options. `owner` names the product in the error, such as `Agent` or
 * `Content`.
 */
export function readPresetSelection(extension: unknown, owner: string): PresetSelection {
  if (!Array.isArray(extension)) return { preset: extension }
  if (extension.length !== 2 || !isPresetOptionsRecord(extension[1])) {
    throw new TypeError(`[vitehub] ${owner} extends tuple requires [preset, options] with an options object.`)
  }
  return { preset: extension[0], options: extension[1] }
}

/**
 * Reject supplied option keys that the preset does not declare in its defaults. `label` completes the message
 * `Unknown <label> option "<key>".`, such as `Agent preset`.
 */
export function assertKnownPresetOptions(defaults: unknown, supplied: Record<string, unknown>, label: string): void {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Preset defaults are untyped input; only plain objects declare options.
  if (defaults === null || typeof defaults !== "object") return
  for (const key of Object.keys(supplied)) {
    if (!Object.hasOwn(defaults, key)) throw new TypeError(`[vitehub] Unknown ${label} option "${key}".`)
  }
}
