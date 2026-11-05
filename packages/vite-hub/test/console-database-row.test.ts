import { expect, it } from "vitest"

import { consoleDatabaseRowFields } from "../src/console/runtime/components/console-database-model"
import type { ConsoleDatabaseColumn, ConsoleDatabaseTable } from "../src/console/runtime/components/console-database-model"

function column(name: string, type: string, primary = false): ConsoleDatabaseColumn {
  return { key: name, name, nullable: !primary, primary, type, unique: primary }
}

const table: ConsoleDatabaseTable = {
  columns: [column("id", "text", true), column("metadata", "json"), column("notes", "text"), column("logo", "text"), column("deleted", "text")],
  name: "organization",
  position: { x: 0, y: 0 },
}

it("lists every column of a row with its full value", () => {
  const fields = consoleDatabaseRowFields(table, {
    id: { kind: "text", value: "org_01NOVA" },
    logo: { kind: "null", value: "NULL" },
    metadata: { kind: "json", value: "{\"plan\":\"starter\",\"seats\":[1,2]}" },
    notes: { kind: "text", truncated: true, value: "x".repeat(40) },
  })
  expect(fields.map(field => [field.column.name, field.text, field.null, field.truncated])).toEqual([
    ["id", "org_01NOVA", false, false],
    ["metadata", "{\n  \"plan\": \"starter\",\n  \"seats\": [\n    1,\n    2\n  ]\n}", false, false],
    ["notes", "x".repeat(40), false, true],
    ["logo", "NULL", true, false],
    ["deleted", "NULL", true, false],
  ])
})

it("keeps a cut JSON value as the server sent it", () => {
  const [, metadata] = consoleDatabaseRowFields(table, { metadata: { kind: "json", truncated: true, value: "{\"plan\":\"sta" } })
  expect(metadata).toMatchObject({ text: "{\"plan\":\"sta", truncated: true })
})
