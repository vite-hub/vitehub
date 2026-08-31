import { describe, expect, it } from "vitest";

import { parseConsoleDatabase } from "../src/console/runtime/components/console-database-model.ts";

describe("Console database inspection", () => {
  it("validates tables, rows, columns, and relationships at the client boundary", () => {
    expect(
      parseConsoleDatabase({
        relationships: [
          {
            from: { column: "userId", table: "session" },
            to: { column: "id", table: "user" },
          },
        ],
        schema: "auth",
        tables: [
          {
            columns: [{ name: "id", primary: true, type: "text" }],
            name: "user",
            position: { x: 10, y: 20 },
            rows: [{ id: "user_01" }, null],
          },
        ],
      }),
    ).toEqual({
      relationships: [
        {
          from: { column: "userId", table: "session" },
          to: { column: "id", table: "user" },
        },
      ],
      schema: "auth",
      tables: [
        {
          columns: [{ name: "id", primary: true, type: "text" }],
          name: "user",
          position: { x: 10, y: 20 },
          rows: [{ id: "user_01" }],
        },
      ],
    });
  });

  it.each([
    undefined,
    { relationships: [], schema: "auth", tables: [] },
    {
      relationships: [],
      schema: "auth",
      tables: [{ columns: [], name: "user", position: { x: 0, y: 0 }, rows: [] }],
    },
  ])("rejects an unusable inspection payload", (value) => {
    expect(() => parseConsoleDatabase(value)).toThrow("database inspection");
  });
});
