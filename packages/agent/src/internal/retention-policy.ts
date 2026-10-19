import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"

/** A size limit in bytes, or a share of the capacity of the volume that holds the store. */
export type RetentionSizeLimit = { bytes: number } | { fraction: number }

export interface NormalizedRetention {
  maxAgeMs: false | number
  maxRecords: false | number
  maxSize: false | RetentionSizeLimit
}

export interface NormalizeRetentionOptions {
  /** Names the owner in messages, such as `SQLite Agent Invocation` or `console.retention`. */
  label: string
  defaults: NormalizedRetention
  /** `any` accepts bytes and percents. `bytes` rejects percents. `none` rejects every maxSize except false and undefined. */
  size: "any" | "bytes" | "none"
  /** Creates the error that the caller throws, so each caller keeps its own diagnostic code. */
  error: (message: string) => Error
}

const durationUnits: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
const sizeUnits: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }
const retentionKeys = new Set(["maxAge", "maxRecords", "maxSize"])
/** The largest age that still gives a cutoff in the JavaScript Date range. */
const maximumAgeMs = 8_640_000_000_000_000

/** Parses a duration such as `14d`, `12h`, `30m`, or `1.5h` to milliseconds. Returns undefined for anything else. */
export function parseRetentionDuration(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(value.trim())
  if (!match) return
  const result = Math.round(Number(match[1]) * durationUnits[match[2]!]!)
  return Number.isSafeInteger(result) && result >= 1 ? result : undefined
}

/** Parses `500MB`, `3 GB` (1024-based, case-insensitive), or `45%`. Returns undefined for anything else. */
export function parseRetentionSize(value: string): RetentionSizeLimit | undefined {
  const text = value.trim()
  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(text)
  if (percent) {
    const fraction = Number(percent[1]) / 100
    return fraction > 0 && fraction <= 1 ? { fraction } : undefined
  }
  const size = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)$/i.exec(text)
  if (!size) return
  const bytes = Math.floor(Number(size[1]) * sizeUnits[size[2]!.toLowerCase()]!)
  return Number.isSafeInteger(bytes) && bytes >= 1 ? { bytes } : undefined
}

/**
 * Validates a retention policy and resolves its units. `undefined` uses the defaults, and `false` disables a limit.
 * Throws the caller's error for null, unknown keys, and values that are not positive.
 */
export function normalizeRetention(input: unknown, options: NormalizeRetentionOptions): NormalizedRetention {
  const { error, label } = options
  if (input === undefined) return options.defaults
  if (!isRuntimeRecord(input) || Array.isArray(input)) throw error(`${label} must be an object with maxAge, maxRecords, or maxSize.`)
  for (const key of Object.keys(input)) {
    if (!retentionKeys.has(key)) {
      const fix = key === "maxAgeMs" ? "Rename it to maxAge." : "Use maxAge, maxRecords, or maxSize."
      throw error(`${label} has an unknown key ${JSON.stringify(key)}. ${fix}`)
    }
  }
  return {
    maxAgeMs: normalizeMaxAge(input.maxAge, options),
    maxRecords: normalizeMaxRecords(input.maxRecords, options),
    maxSize: normalizeMaxSize(input.maxSize, options),
  }
}

function normalizeMaxAge(value: unknown, { defaults, error, label }: NormalizeRetentionOptions): false | number {
  if (value === undefined) return defaults.maxAgeMs
  if (value === false) return false
  const result = hasRuntimeType(value, "string")
    ? parseRetentionDuration(value)
    : hasRuntimeType(value, "number") && Number.isSafeInteger(value) && value >= 1 ? value : undefined
  if (result === undefined || result > maximumAgeMs) throw error(`${label} maxAge must be a positive duration such as 14d, a number of milliseconds, or false.`)
  return result
}

function normalizeMaxRecords(value: unknown, { defaults, error, label }: NormalizeRetentionOptions): false | number {
  if (value === undefined) return defaults.maxRecords
  if (value === false) return false
  if (!hasRuntimeType(value, "number") || !Number.isSafeInteger(value) || value < 1) {
    throw error(`${label} maxRecords must be a positive safe integer or false.`)
  }
  return value
}

function normalizeMaxSize(value: unknown, { defaults, error, label, size }: NormalizeRetentionOptions): false | RetentionSizeLimit {
  if (value === undefined) return defaults.maxSize
  if (value === false) return false
  if (size === "none") throw error(`${label} stores do not support maxSize. Use maxRecords or maxAge.`)
  const result = hasRuntimeType(value, "string")
    ? parseRetentionSize(value)
    : hasRuntimeType(value, "number") && Number.isSafeInteger(value) && value >= 1 ? { bytes: value } : undefined
  if (result === undefined) {
    throw error(`${label} maxSize must be a positive size such as 500MB, a number of bytes, a percent such as 45%, or false.`)
  }
  if (size === "bytes" && "fraction" in result) throw error(`${label} maxSize does not support a percent. Use a size such as 500MB.`)
  return result
}
