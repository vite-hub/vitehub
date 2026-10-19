/** Units of a retention duration string: milliseconds, seconds, minutes, hours, days, and weeks. */
export type AgentRetentionDurationUnit = "ms" | "s" | "m" | "h" | "d" | "w"

/** A duration such as `"14d"`, `"12h"`, `"30m"`, or `"1.5h"`. */
export type AgentRetentionDuration = `${number}${AgentRetentionDurationUnit}`

/** Units of a retention size string. They are 1024-based and case-insensitive: `1KB` is 1024 bytes. */
export type AgentRetentionSizeUnit = "B" | "KB" | "MB" | "GB" | "TB" | "b" | "kb" | "mb" | "gb" | "tb"

/**
 * A size such as `"500MB"` or `"3 GB"`, or a percent such as `"45%"`.
 * A percent is a share of the capacity of the volume that holds the store. It counts only the store's own bytes.
 */
export type AgentRetentionSize = `${number}${AgentRetentionSizeUnit}` | `${number} ${AgentRetentionSizeUnit}` | `${number}%`

/**
 * Retention limits for stored data. All limits that are set apply together: the oldest data that can be removed goes first,
 * until every limit holds. `false` disables a limit. An omitted limit uses the store's default.
 * Pending and running Agent Invocations are never removed by retention.
 */
export interface AgentRetentionPolicy {
  /** Maximum age, measured from the last update. A number is milliseconds. A string is a duration such as `"14d"`. */
  maxAge?: false | number | AgentRetentionDuration
  /** Maximum number of records. Stores may apply it periodically, so the count can briefly exceed it. */
  maxRecords?: false | number
  /**
   * Maximum size. A number is bytes. A string is a size such as `"500MB"`, or a percent of the volume such as `"45%"`.
   * Stores apply it periodically, so the size can briefly exceed it. Not every store supports it.
   */
  maxSize?: false | number | AgentRetentionSize
}
