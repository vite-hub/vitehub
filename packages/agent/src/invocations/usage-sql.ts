import type { AgentUsagePeriod, AgentUsageQuery } from "../usage.ts"

export const agentUsageMetrics = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens"] as const
const metrics = agentUsageMetrics
export const agentUsageCostParts = ["w", "f1", "f2", "f3", "f4"] as const
const parts = agentUsageCostParts
const chunk = 1_000_000_000
export const agentUsageFractionDigits = 36
const fractionDigits = agentUsageFractionDigits

function text(json: string, path: string): string {
  return `CASE WHEN json_type(${json}, '${path}') = 'text' THEN json_extract(${json}, '${path}') END`
}

function trimmedText(json: string, path: string): string {
  return `NULLIF(trim(${text(json, path)}), '')`
}

function count(json: string, ...paths: string[]): string {
  const values = paths.map(path => `CASE WHEN json_type(${json}, '${path}') IN ('integer', 'real') AND json_extract(${json}, '${path}') >= 0 THEN json_extract(${json}, '${path}') END`)
  return values.length === 1 ? values[0]! : `COALESCE(${values.join(", ")})`
}

function flag(json: string, path: string): string {
  return `CASE WHEN json_type(${json}, '${path}') = 'true' THEN 1 ELSE 0 END`
}

function usageFields(json: string): string {
  return [
    `${count(json, "$.usage.inputTokens")} AS inputTokens0`,
    `${count(json, "$.usage.outputTokens")} AS outputTokens0`,
    `${count(json, "$.usage.totalTokens")} AS totalTokens0`,
    `${count(json, "$.usage.inputTokenDetails.cacheReadTokens", "$.usage.inputTokenDetails.cacheRead", "$.usage.inputTokenDetails.cachedTokens", "$.usage.details.cachedInputTokens")} AS cachedInputTokens0`,
    `${count(json, "$.usage.inputTokenDetails.cacheWriteTokens", "$.usage.inputTokenDetails.cacheWrite")} AS cacheWriteTokens0`,
    `${count(json, "$.usage.outputTokenDetails.reasoningTokens", "$.usage.outputTokenDetails.reasoningOutputTokens", "$.usage.outputTokenDetails.reasoning", "$.usage.details.reasoningOutputTokens")} AS reasoningTokens0`,
    `${text(json, "$.cost.usd")} AS usdText`,
    `${flag(json, "$.cost.estimated")} AS estimated`,
  ].join(", ")
}

function decimal(value: string): string {
  const dot = `instr(${value} || '.', '.')`
  return `CASE WHEN ${value} GLOB '[0-9]*' AND ${value} NOT GLOB '*[^0-9.]*' AND ${value} NOT GLOB '*.*.*' AND ${value} NOT GLOB '*.'
    AND ${dot} <= 13 AND length(${value}) - ${dot} <= ${fractionDigits} THEN ${value} END`
}

function decimalParts(value: string, prefix: string): string {
  const dot = `instr(${value} || '.', '.')`
  const fraction = `substr(${value}, ${dot} + 1)`
  const padded = `substr(${fraction} || '${"0".repeat(fractionDigits)}', 1, ${fractionDigits})`
  return [
    `CAST(substr(${value}, 1, ${dot} - 1) AS INTEGER) AS ${prefix}w`,
    ...[1, 2, 3, 4].map(index => `CAST(substr(${padded}, ${index * 9 - 8}, 9) AS INTEGER) AS ${prefix}f${index}`),
    `length(${fraction}) AS ${prefix}scale`,
  ].join(", ")
}

function strippedScale(prefix: string): string {
  const digits = (index: number) => `length(rtrim(printf('%09d', ${prefix}f${index}), '0'))`
  return `CASE WHEN ${prefix}f4 <> 0 THEN 27 + ${digits(4)} WHEN ${prefix}f3 <> 0 THEN 18 + ${digits(3)}
    WHEN ${prefix}f2 <> 0 THEN 9 + ${digits(2)} WHEN ${prefix}f1 <> 0 THEN ${digits(1)} ELSE 0 END`
}

function carried(source: string, target: string): string {
  const total = (part: string, carry?: string) => carry ? `(${source}${part} + ${carry} / ${chunk})` : `${source}${part}`
  const f4 = total("f4")
  const f3 = total("f3", f4)
  const f2 = total("f2", f3)
  const f1 = total("f1", f2)
  return [
    `${total("w", f1)} AS ${target}w`,
    `${f1} % ${chunk} AS ${target}f1`,
    `${f2} % ${chunk} AS ${target}f2`,
    `${f3} % ${chunk} AS ${target}f3`,
    `${f4} % ${chunk} AS ${target}f4`,
  ].join(", ")
}

function partSums(source: string, target: string, when?: string): string {
  return parts.map(part => `SUM(${when ? `CASE WHEN ${when} THEN ${source}${part} END` : `${source}${part}`}) AS ${target}${part}`).join(", ")
}

function totalsObject(): string {
  return `json_patch(json_object('n', COUNT(*),
    ${metrics.map(metric => `'${metric}', SUM(${metric}), '${metric}Count', COUNT(${metric})`).join(", ")}),
    json_object('priced', SUM(hasCost), 'estimated', MAX(CASE WHEN hasCost THEN costEstimated ELSE 0 END),
    ${parts.map(part => `'${part}', CAST(SUM(CASE WHEN hasCost THEN cost${part} END) AS TEXT)`).join(", ")},
    'scale', MAX(CASE WHEN hasCost THEN costScale END)))`
}

function detailObject(): string {
  return `json_object('id', id, 'agentName', agent, 'title', title, 'status', status, 'createdAt', COALESCE(createdText, updatedColumn),
    'completedAt', completedText, 'updatedAt', COALESCE(updatedText, updatedColumn), 'model', configuredText, 'missing', missing,
    'finish', json(finish),
    'recorded', CASE WHEN missing THEN NULL ELSE (SELECT json_group_array(json(j.value)) FROM json_each(record, '$.observations') j
      WHERE j.type = 'object' AND json_extract(j.value, '$.name') = 'agent.usage.recorded') END)`
}

export function agentUsageStatement(table: string, options: AgentUsageQuery, period: AgentUsagePeriod): { sql: string, args: Array<string | number> } {
  const args: Array<string | number> = []
  const arg = (value: string | number) => {
    args.push(value)
    return `?${args.length}`
  }
  const bucketFormat = period.window.bucket === "hour" ? "%Y-%m-%dT%H:00:00.000Z" : "%Y-%m-%dT00:00:00.000Z"
  const search = options.search?.toLowerCase()
  const filters = [
    `at >= ${arg(period.from)}`,
    `at <= ${arg(period.to)}`,
    `strftime('${bucketFormat}', at) IS NOT NULL`,
    ...(options.agentName ? [`agent = ${arg(options.agentName)}`] : []),
    ...(search ? [`(instr(lower(id), ${arg(search)}) > 0 OR instr(lower(COALESCE(title, '')), ${arg(search)}) > 0 OR instr(lower(agent), ${arg(search)}) > 0)`] : []),
  ]
  const after = period.after
    ? `WHERE at < ${arg(period.after.at)} OR (at = ${arg(period.after.at)} AND id < ${arg(period.after.id)})`
    : ""
  const costPart = (part: string) => `CASE costSource WHEN 'own' THEN own${part} WHEN 'calls' THEN calls${part} WHEN 'recorded' THEN recorded${part} END AS cost${part}`
  const sql = `WITH
source AS MATERIALIZED (
  SELECT s.id, s.status, s.updated_at AS updatedColumn, s.agent_name AS agentColumn,
    CASE WHEN json_valid(s.record) THEN CASE WHEN json_type(s.record, '$.observations') = 'array' THEN s.record END END AS record
  FROM ${table} s
  WHERE s.status IN ('completed', 'failed', 'cancelled')${options.status ? ` AND s.status = ${arg(options.status)}` : ""}
    AND (s.updated_at >= ${arg(period.from)} OR s.updated_at = '')
),
fields AS MATERIALIZED (
  SELECT id, status, updatedColumn, record, record IS NULL AS missing,
    COALESCE(${text("record", "$.agentName")}, agentColumn, '') AS agent,
    ${text("record", "$.title")} AS title,
    ${text("record", "$.createdAt")} AS createdText,
    ${text("record", "$.completedAt")} AS completedText,
    ${text("record", "$.updatedAt")} AS updatedText,
    ${text("record", `$.annotations."agent.model.id"`)} AS configuredText,
    (SELECT j.value FROM json_each(record, '$.observations') j
      WHERE j.type = 'object' AND json_extract(j.value, '$.name') = 'agent.invocation.finish'
      ORDER BY j.key DESC LIMIT 1) AS finish
  FROM source
),
timed AS MATERIALIZED (
  SELECT *, CASE WHEN missing THEN updatedColumn ELSE COALESCE(NULLIF(completedText, ''), NULLIF(updatedText, ''), createdText, '') END AS at
  FROM fields
),
selected AS MATERIALIZED (
  SELECT *, strftime('${bucketFormat}', at) AS bucket,
    ${flag("finish", `$.attributes."vitehub.observation.truncated"`)} AS truncated,
    CASE WHEN json_type(finish, '$.attributes."usage.record"') = 'object' THEN json_extract(finish, '$.attributes."usage.record"') END AS rec
  FROM timed WHERE ${filters.join(" AND ")}
),
own AS MATERIALIZED (
  SELECT selected.*, COALESCE(${trimmedText("rec", "$.model")}, NULLIF(trim(configuredText), '')) AS model,
    CASE WHEN truncated = 0 AND json_type(rec, '$.calls') = 'array' THEN json_array_length(rec, '$.calls') ELSE 0 END AS callCount,
    ${usageFields("rec")}
  FROM selected
),
ownCost AS MATERIALIZED (
  SELECT own.*, ${decimal("usdText")} AS usd FROM own
),
ownParts AS MATERIALIZED (
  SELECT ownCost.*, ${decimalParts("usd", "own")} FROM ownCost
),
callItems AS MATERIALIZED (
  SELECT o.id, o.bucket, o.model AS parentModel, CASE WHEN c.type = 'object' THEN c.value END AS call
  FROM ownParts o, json_each(o.rec, '$.calls') c WHERE o.callCount > 0
),
callFields AS MATERIALIZED (
  SELECT id, bucket, parentModel, call IS NOT NULL AS isObject, ${trimmedText("call", "$.model")} AS callModel, ${usageFields("call")}
  FROM callItems
),
callCost AS MATERIALIZED (
  SELECT callFields.*, ${decimal("usdText")} AS usd FROM callFields
),
calls AS MATERIALIZED (
  SELECT id, bucket, COALESCE(callModel, parentModel, 'Unknown model') AS modelKey,
    isObject AND (COALESCE(callModel, parentModel) IS NOT NULL OR ${metrics.map(metric => `${metric}0 IS NOT NULL`).join(" OR ")} OR usd IS NOT NULL) AS valid,
    inputTokens0 AS inputTokens, outputTokens0 AS outputTokens, COALESCE(totalTokens0, inputTokens0 + outputTokens0) AS totalTokens,
    cachedInputTokens0 AS cachedInputTokens, cacheWriteTokens0 AS cacheWriteTokens, reasoningTokens0 AS reasoningTokens,
    usd, estimated, ${decimalParts("usd", "cost")}
  FROM callCost
),
callSums AS MATERIALIZED (
  SELECT id, COUNT(*) AS n, SUM(valid) AS validCount,
    ${metrics.map(metric => `SUM(${metric}) AS ${metric}, COUNT(${metric}) AS ${metric}Count`).join(", ")},
    COUNT(usd) AS costCount, MAX(estimated) AS estimated, ${partSums("cost", "sum")}
  FROM calls GROUP BY id
),
callTotals AS MATERIALIZED (
  SELECT callSums.*, ${carried("sum", "calls")} FROM callSums
),
recordedItems AS MATERIALIZED (
  SELECT o.id,
    CASE WHEN json_type(j.value, '$.attributes."usage.hasCost"') = 'false' THEN NULL ELSE ${text("j.value", `$.attributes."usage.costUsd"`)} END AS usdText,
    ${flag("j.value", `$.attributes."usage.costEstimated"`)} AS estimated
  FROM ownParts o, json_each(o.record, '$.observations') j
  WHERE o.usd IS NULL AND o.rec IS NOT NULL AND j.type = 'object' AND json_extract(j.value, '$.name') = 'agent.usage.recorded'
),
recordedCost AS MATERIALIZED (
  SELECT recordedItems.*, ${decimal("usdText")} AS usd FROM recordedItems
),
recordedParts AS MATERIALIZED (
  SELECT recordedCost.*, ${decimalParts("usd", "cost")} FROM recordedCost
),
recordedSums AS MATERIALIZED (
  SELECT id, COUNT(*) AS n, COUNT(usd) AS costCount, MAX(estimated) AS estimated, ${partSums("cost", "sum")}
  FROM recordedParts GROUP BY id
),
recordedTotals AS MATERIALIZED (
  SELECT recordedSums.*, ${carried("sum", "recorded")} FROM recordedSums
),
usageFill AS MATERIALIZED (
  SELECT o.*, o.callCount > 0 AND cs.validCount = cs.n AS fill,
    o.rec IS NOT NULL AND (o.model IS NOT NULL OR ${metrics.map(metric => `o.${metric}0 IS NOT NULL`).join(" OR ")} OR o.usd IS NOT NULL OR o.callCount > 0) AS defined,
    cs.n AS callN, cs.costCount AS callCostCount, cs.estimated AS callsEstimated, ${parts.map(part => `cs.calls${part}`).join(", ")},
    rs.n AS recordedN, rs.costCount AS recordedCostCount, rs.estimated AS recordedEstimated, ${parts.map(part => `rs.recorded${part}`).join(", ")},
    ${metrics.map(metric => `cs.${metric} AS call${metric}, cs.${metric}Count AS call${metric}Count`).join(", ")}
  FROM ownParts o LEFT JOIN callTotals cs ON cs.id = o.id LEFT JOIN recordedTotals rs ON rs.id = o.id
),
usageSource AS MATERIALIZED (
  SELECT *, CASE WHEN usd IS NOT NULL THEN 'own'
    WHEN fill AND callCostCount = callN THEN 'calls'
    WHEN defined AND recordedN > 0 AND recordedCostCount = recordedN THEN 'recorded' END AS costSource
  FROM usageFill
),
usage AS MATERIALIZED (
  SELECT id, status, agent, title, at, bucket, missing, truncated, defined, callCount, model, record, finish,
    createdText, completedText, updatedText, updatedColumn, configuredText,
    ${metrics.map(metric => metric === "totalTokens"
      ? `COALESCE(totalTokens0, inputTokens0 + outputTokens0, CASE WHEN fill AND calltotalTokensCount = callN THEN calltotalTokens END) AS totalTokens`
      : `COALESCE(${metric}0, CASE WHEN fill AND call${metric}Count = callN THEN call${metric} END) AS ${metric}`).join(", ")},
    costSource IS NOT NULL AS hasCost,
    CASE costSource WHEN 'own' THEN estimated WHEN 'calls' THEN callsEstimated WHEN 'recorded' THEN recordedEstimated ELSE 0 END AS costEstimated,
    ${parts.map(costPart).join(", ")},
    CASE costSource WHEN 'own' THEN ownscale ELSE NULL END AS ownScale
  FROM usageSource
),
costed AS MATERIALIZED (
  SELECT *, CASE WHEN hasCost THEN COALESCE(ownScale, ${strippedScale("cost")}) END AS costScale,
    CASE WHEN hasCost THEN ${strippedScale("cost")} END AS pairScale
  FROM usage
),
callPairSums AS MATERIALIZED (
  SELECT id, bucket, modelKey, COUNT(*) AS n,
    ${metrics.map(metric => `SUM(${metric}) AS ${metric}, COUNT(${metric}) AS ${metric}Count`).join(", ")},
    COUNT(usd) AS costCount, MAX(estimated) AS estimated, ${partSums("cost", "sum")}
  FROM calls GROUP BY id, modelKey
),
callPairTotals AS MATERIALIZED (
  SELECT callPairSums.*, ${carried("sum", "cost")} FROM callPairSums
),
pairs AS MATERIALIZED (
  SELECT bucket, modelKey AS model,
    ${metrics.map(metric => `CASE WHEN ${metric}Count = n THEN ${metric} END AS ${metric}`).join(", ")},
    costCount = n AS hasCost, estimated AS costEstimated, ${parts.map(part => `cost${part}`).join(", ")}, ${strippedScale("cost")} AS costScale
  FROM callPairTotals
  UNION ALL
  SELECT bucket, COALESCE(model, 'Unknown model'), ${metrics.join(", ")}, hasCost, costEstimated, ${parts.map(part => `cost${part}`).join(", ")}, pairScale
  FROM costed WHERE defined AND callCount = 0
)
SELECT * FROM (
  SELECT 'total' AS kind, NULL AS key, NULL AS model,
    json_insert(${totalsObject()}, '$.partial', MAX(missing OR truncated OR totalTokens IS NULL)) AS data
  FROM costed
  UNION ALL SELECT 'bucket', bucket, NULL, ${totalsObject()} FROM costed GROUP BY bucket
  UNION ALL SELECT 'agent', agent, NULL, ${totalsObject()} FROM costed GROUP BY agent
  UNION ALL SELECT 'model', NULL, model, ${totalsObject()} FROM pairs GROUP BY model
)
UNION ALL SELECT * FROM (
  SELECT 'bucketModel', bucket, model, ${totalsObject()} FROM pairs GROUP BY bucket, model
  UNION ALL SELECT * FROM (SELECT 'page', NULL, NULL, ${detailObject()} FROM costed ${after} ORDER BY at DESC, id DESC LIMIT 51)
  UNION ALL SELECT * FROM (SELECT 'expensive', NULL, NULL, ${detailObject()} FROM costed WHERE hasCost AND NOT missing
    ORDER BY costw DESC, printf('%09d%09d%09d%09d', costf1, costf2, costf3, costf4) DESC, at DESC, id DESC LIMIT 10)
)`
  return { sql, args }
}
