import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import {
  consoleDatabaseKey,
  consoleDatabaseRegistryKey,
  consoleDatabaseRootKey,
} from "../src/console/internal.ts";
import {
  consoleDatabaseRequestQuery,
  parseConsoleDatabase,
} from "../src/console/runtime/components/console-database-model.ts";
import consoleDatabaseHandler from "../src/console/runtime/server/database.get.ts";
import { installConsoleDatabase } from "../src/console/runtime/server/database.ts";

const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("full_name"),
});
const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  authorId: integer("author_id")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
});
const schema = { posts, users };
const clients: Array<ReturnType<typeof createClient>> = [];

function event(query = "", method = "GET") {
  return { method, req: { url: `http://localhost/api/_vitehub/console/database${query}` } };
}

async function database(name = "default") {
  const client = createClient({ url: "file::memory:" });
  clients.push(client);
  const db = drizzle({ client, schema });
  await client.execute(
    "create table users (id integer primary key autoincrement, email text not null unique, full_name text)",
  );
  await client.execute(
    "create table posts (id integer primary key autoincrement, author_id integer not null references users(id), title text not null)",
  );
  await db.insert(users).values([
    { email: "ada@example.com", name: "Ada Lovelace" },
    { email: "grace@example.com", name: "Grace Hopper" },
    { email: "linus@example.com", name: null },
  ]);
  await db.insert(posts).values({ authorId: 1, title: `${name} database` });
  return { db, schema };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  Reflect.deleteProperty(globalThis, consoleDatabaseKey);
  Reflect.deleteProperty(globalThis, consoleDatabaseRootKey);
  Reflect.deleteProperty(process, consoleDatabaseKey);
  Reflect.deleteProperty(process, consoleDatabaseRootKey);
  Reflect.deleteProperty(process, consoleDatabaseRegistryKey);
});

describe("Console database inspection", () => {
  it("omits table controls from schema requests", () => {
    expect(
      consoleDatabaseRequestQuery({
        database: "default",
        direction: "desc",
        offset: 50,
        search: "Ada",
        sort: "email",
        table: "users",
        view: "schema",
      }),
    ).toEqual({ database: "default" });
  });

  it("lists schema metadata before reading a selected table", async () => {
    installConsoleDatabase("/project", { default: await database() }, ["default"]);

    const result = await consoleDatabaseHandler(event());

    expect(result).toMatchObject({
      database: "default",
      databases: ["default"],
      rows: [],
      total: 0,
    });
    expect(result.table).toBeUndefined();
    expect(result.tables.map((table) => table.name)).toEqual(["posts", "users"]);
    expect(result.tables.find((table) => table.name === "users")?.columns).toEqual([
      expect.objectContaining({ key: "id", name: "id", nullable: false, primary: true }),
      expect.objectContaining({ key: "email", name: "email", nullable: false, unique: true }),
      expect.objectContaining({ key: "name", name: "full_name", nullable: true }),
    ]);
    expect(result.relationships).toContainEqual({
      from: { column: "author_id", table: "posts" },
      to: { column: "id", table: "users" },
    });
  });

  it("paginates, filters, and sorts rows through structured read-only inputs", async () => {
    installConsoleDatabase("/project", { default: await database() }, ["default"]);

    const page = await consoleDatabaseHandler(
      event("?table=users&limit=1&offset=1&sort=email&direction=desc"),
    );
    expect(page).toMatchObject({
      direction: "desc",
      limit: 1,
      offset: 1,
      sort: "email",
      table: "users",
      total: 3,
    });
    expect(page.rows).toEqual([
      {
        email: { kind: "text", value: "grace@example.com" },
        id: { kind: "number", value: "2" },
        name: { kind: "text", value: "Grace Hopper" },
      },
    ]);

    const filtered = await consoleDatabaseHandler(event("?table=users&search=lovelace"));
    expect(filtered.total).toBe(1);
    expect(filtered.rows[0]?.email).toEqual({ kind: "text", value: "ada@example.com" });
  });

  it("selects named databases and rejects mutation or free-form query inputs", async () => {
    installConsoleDatabase(
      "/project",
      { analytics: await database("analytics"), default: await database() },
      ["analytics", "default"],
    );

    const named = await consoleDatabaseHandler(event("?database=analytics&table=posts"));
    expect(named.database).toBe("analytics");
    expect(named.databases).toEqual(["default", "analytics"]);
    expect(named.rows[0]?.title).toEqual({ kind: "text", value: "analytics database" });

    await expect(consoleDatabaseHandler(event("?table=users", "POST"))).rejects.toMatchObject({
      statusCode: 405,
    });
    await expect(consoleDatabaseHandler(event("?database=missing"))).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      consoleDatabaseHandler(event("?table=users&sort=drop%20table%20users")),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(consoleDatabaseHandler(event("?table=users&limit=101"))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("validates the serialized response at the client boundary", () => {
    const value = parseConsoleDatabase({
      database: "default",
      databases: ["default"],
      direction: "asc",
      limit: 50,
      offset: 0,
      relationships: [
        {
          from: { column: "author_id", table: "posts" },
          to: { column: "id", table: "users" },
        },
      ],
      rows: [{ id: { kind: "number", value: "1" } }],
      search: "",
      table: "users",
      tables: [
        {
          columns: [
            {
              key: "id",
              name: "id",
              nullable: false,
              primary: true,
              type: "integer",
              unique: false,
            },
          ],
          name: "users",
        },
      ],
      total: 1,
    });

    expect(value.tables[0]).toMatchObject({ name: "users", position: { x: 32, y: 32 } });
    expect(value.rows[0]?.id).toEqual({ kind: "number", value: "1" });
  });

  it.each([
    undefined,
    {
      database: "default",
      databases: [],
      direction: "asc",
      limit: 50,
      offset: 0,
      relationships: [],
      rows: [],
      search: "",
      tables: [],
      total: 0,
    },
    {
      database: "default",
      databases: ["default"],
      direction: "sideways",
      limit: 50,
      offset: 0,
      relationships: [],
      rows: [],
      search: "",
      tables: [],
      total: 0,
    },
  ])("rejects an unusable inspection payload", (value) => {
    expect(() => parseConsoleDatabase(value)).toThrow("database inspection");
  });
});
