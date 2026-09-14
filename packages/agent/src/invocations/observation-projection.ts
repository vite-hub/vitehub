/** Bind a JSON array of exact observation names. Only matching payloads leave SQLite. */
export const filteredObservationRecord = `json_set(record, '$.observations', json((
  SELECT json_group_array(json(value)) FROM (
    SELECT value FROM json_each(record, '$.observations')
    WHERE json_extract(value, '$.name') IN (SELECT value FROM json_each(?))
    ORDER BY CAST(key AS INTEGER)
  )
)))`
