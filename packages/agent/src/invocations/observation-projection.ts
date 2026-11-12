import type { AgentInvocationGetOptions } from "../invocations.ts"

/**
 * Selects the `record` column with only the observations that the read options ask for. Only matching payloads leave SQLite.
 * Bind `args` before the other arguments of the statement.
 */
export function observationRecordProjection(options: AgentInvocationGetOptions = {}): { args: (number | string)[], sql: string } {
  const conditions: string[] = []
  const args: (number | string)[] = []
  if (options.observationNames) {
    conditions.push("json_extract(value, '$.name') IN (SELECT value FROM json_each(?))")
    args.push(JSON.stringify(options.observationNames))
  }
  if (options.afterSequence !== undefined) {
    conditions.push("json_extract(value, '$.sequence') > ?")
    args.push(options.afterSequence)
  }
  if (!conditions.length) return { args, sql: "record" }
  return {
    args,
    sql: `json_set(record, '$.observations', json((
  SELECT json_group_array(json(value)) FROM (
    SELECT value FROM json_each(record, '$.observations')
    WHERE ${conditions.join(" AND ")}
    ORDER BY CAST(key AS INTEGER)
  )
)))`,
  }
}
