import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

import { consoleState } from "../src/console/internal.ts";
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts";
import { installConsoleDatabase } from "../src/console/runtime/server/database.ts";
import { installConsoleSections } from "../src/console/runtime/server/sections.ts";
import { handleConsoleRpcRequest } from "./support/console-rpc.ts";
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts";

const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("full_name"),
  profile: jsonb("profile"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
});
const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  authorId: integer("author_id").notNull().references(() => users.id),
  title: text("title").notNull(),
});
const schema = { posts, users };
const clients: PGlite[] = [];

async function database() {
  const client = new PGlite();
  clients.push(client);
  const db = drizzle({ client });
  await client.exec(`
    create table users (id serial primary key, email text not null unique, full_name text, profile jsonb, created_at timestamp not null);
    create table posts (id serial primary key, author_id integer not null references users(id), title text not null);
  `);
  await db.insert(users).values([
    { createdAt: new Date("2026-01-01T00:00:00Z"), email: "ada@example.com", name: "Ada Lovelace", profile: { role: "admin" } },
    { createdAt: new Date("2026-01-02T00:00:00Z"), email: "grace@example.com", name: "Grace Hopper", profile: null },
    { createdAt: new Date("2026-01-03T00:00:00Z"), email: "linus@example.com", name: null, profile: null },
  ]);
  await db.insert(posts).values({ authorId: 1, title: "Postgres database" });
  return { db, schema };
}

async function call(operation: string, input: Record<string, unknown>) {
  const response = await handleConsoleRpcRequest(new Request("http://localhost/_vitehub/rpc", {
    body: operationRpcBody(operation, input),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
  }), { remoteAddress: "127.0.0.1" });
  expect(response.status).toBe(200);
  return await operationRpcResponseResult(response);
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  delete consoleState().database;
  delete consoleState().sections;
  delete consoleState().navigationSections;
});

describe("Console database inspection on Postgres", () => {
  it("lists the tables, columns, and relationships of a Postgres schema", async () => {
    installConsoleSections("/project", ["databases"], ["databases"]);
    installConsoleDatabase("/project", { default: await database() }, ["default"]);

    const result = await call("databases.tables", {});

    expect(result).toMatchObject({ ok: true, value: { tables: [{ name: "posts" }, { name: "users" }] } });
    const value = (result as { value: { relationships: unknown[], tables: Array<{ columns: unknown[], name: string }> } }).value;
    expect(value.tables.find(table => table.name === "users")?.columns).toEqual([
      expect.objectContaining({ key: "id", name: "id", nullable: false, primary: true, type: "serial" }),
      expect.objectContaining({ key: "email", name: "email", nullable: false, unique: true, type: "text" }),
      expect.objectContaining({ key: "name", name: "full_name", nullable: true }),
      expect.objectContaining({ key: "profile", name: "profile", type: "jsonb" }),
      expect.objectContaining({ key: "createdAt", name: "created_at", type: "timestamp" }),
    ]);
    expect(value.relationships).toContainEqual({ from: { column: "author_id", table: "posts" }, to: { column: "id", table: "users" } });
  });

  it("pages, sorts, and filters the rows of a Postgres table", async () => {
    installConsoleSections("/project", ["databases"], ["databases"]);
    installConsoleDatabase("/project", { default: await database() }, ["default"]);

    const page = await call("databases.browse", { direction: "desc", limit: 1, offset: 1, sort: "email", table: "users" });
    expect(page).toMatchObject({ ok: true, value: { table: "users", total: 3 } });
    expect((page as { value: { rows: unknown[] } }).value.rows).toEqual([{
      createdAt: { kind: "date", value: "2026-01-02T00:00:00.000Z" },
      email: { kind: "text", value: "grace@example.com" },
      id: { kind: "number", value: "2" },
      name: { kind: "text", value: "Grace Hopper" },
      profile: { kind: "null", value: "NULL" },
    }]);

    const filtered = await call("databases.browse", { search: "ADMIN", table: "users" });
    expect(filtered).toMatchObject({ ok: true, value: { rows: [{ email: { value: "ada@example.com" }, profile: { kind: "json", value: "{\"role\":\"admin\"}" } }], total: 1 } });
  });
});
