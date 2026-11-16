import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabaseEnvStore, listDatabaseEnvNamespaces } from "../src/database.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function setup() {
  const client = createClient({ url: ":memory:" });
  cleanup.push(() => client.close());
  const db = drizzle({ client });
  const store = (namespace: string) => createDatabaseEnvStore({ db, encryptionKeys: [new Uint8Array(32).fill(4)], namespace });
  return { db, store };
}

describe("database Env store keys", () => {
  it("lists the keys of one namespace without values, and removes one", async () => {
    const { db, store } = setup();
    expect(await listDatabaseEnvNamespaces(db, "p1:")).toEqual([]);
    const production = store("p1:production");
    await production.secrets.replace({ key: "B_TOKEN", value: "secret-b", expectedRevision: null });
    await production.secrets.replace({ key: "A_TOKEN", value: "secret-a", expectedRevision: null });
    await store("p1:staging").secrets.replace({ key: "A_TOKEN", value: "secret-s", expectedRevision: null });
    await store("p10:production").secrets.replace({ key: "A_TOKEN", value: "other", expectedRevision: null });

    const listed = await production.list();
    expect(listed.map((item) => item.key)).toEqual(["A_TOKEN", "B_TOKEN"]);
    expect(JSON.stringify(listed)).not.toContain("secret-");
    expect(await listDatabaseEnvNamespaces(db, "p1:")).toEqual(["p1:production", "p1:staging"]);

    expect(await production.remove("A_TOKEN")).toBe(true);
    expect(await production.remove("A_TOKEN")).toBe(false);
    expect(await production.secrets.read("A_TOKEN")).toBeUndefined();
    expect((await store("p1:staging").secrets.read("A_TOKEN"))?.value).toBe("secret-s");
  });

  it("keeps a remove event in the activity", async () => {
    const { store } = setup();
    const production = store("p1:production");
    const event = { id: "e1", operationId: "e1", timestamp: new Date().toISOString(), actor: { id: "u1", kind: "user" as const }, key: "A_TOKEN", action: "remove" as const, outcome: "succeeded" as const };
    await production.access.append(event);
    expect(await production.access.activity({ key: "A_TOKEN", limit: 10 })).toEqual([event]);
  });
});
