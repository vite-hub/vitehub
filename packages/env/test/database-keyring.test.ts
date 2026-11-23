import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { SQLiteDialect } from "drizzle-orm/sqlite-core";
import type { SQL } from "drizzle-orm";
import { createDatabaseEnvStore } from "../src/database.ts";
import type { EnvDatabase } from "../src/database.ts";
import { importSealKey, sealKeyId, sealWithKey } from "../src/seal.ts";

const keyA = new Uint8Array(32).fill(1);
const keyB = new Uint8Array(32).fill(2);
const keyC = new Uint8Array(32).fill(3);
const dialect = new SQLiteDialect();
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function database() {
  const client = createClient({ url: ":memory:" });
  cleanup.push(() => client.close());
  return drizzle({ client });
}

async function payload(db: EnvDatabase, key: string): Promise<string> {
  const [row] = (await db.all(sql`SELECT payload FROM vitehub_env_secrets WHERE key = ${key}`)) as Array<{ payload: string }>;
  return row!.payload;
}

function aad(namespace: string, key: string, revision: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([namespace, key, revision]));
}

describe("database Env store keyring", () => {
  it("reads old rows after a new current key, rotates them, and reads all without the old key", async () => {
    const db = database();
    const withA = createDatabaseEnvStore({ db, encryptionKeys: [keyA] });
    const github = await withA.secrets.replace({ key: "github", value: "token-a", expectedRevision: null });
    await withA.secrets.replace({ key: "slack", value: "token-s", expectedRevision: null });
    expect(await payload(db, "github")).toMatch(new RegExp(`^v2:${await sealKeyId(keyA)}:[a-f0-9]{24}:[a-f0-9]+$`));

    const withBA = createDatabaseEnvStore({ db, encryptionKeys: [keyB, keyA] });
    expect(await withBA.secrets.read("github")).toEqual({ value: "token-a", revision: github.revision });
    await withBA.secrets.replace({ key: "linear", value: "token-b", expectedRevision: null });
    expect(await payload(db, "linear")).toMatch(new RegExp(`^v2:${await sealKeyId(keyB)}:`));

    expect(await withBA.rotate()).toEqual({ rotated: 2, skipped: 1 });
    expect(await withBA.rotate()).toEqual({ rotated: 0, skipped: 3 });

    const withB = createDatabaseEnvStore({ db, encryptionKeys: [keyB] });
    expect(await withB.secrets.read("github")).toEqual({ value: "token-a", revision: github.revision });
    expect((await withB.secrets.read("slack"))?.value).toBe("token-s");
    expect((await withB.secrets.read("linear"))?.value).toBe("token-b");
  });

  it("rejects a value whose key id was changed", async () => {
    const db = database();
    const store = createDatabaseEnvStore({ db, encryptionKeys: [keyA, keyB] });
    await store.secrets.replace({ key: "github", value: "token", expectedRevision: null });
    const original = await payload(db, "github");
    for (const id of [await sealKeyId(keyB), await sealKeyId(keyC)]) {
      const tampered = original.replace(/^v2:[a-f0-9]{16}:/, `v2:${id}:`);
      await db.run(sql`UPDATE vitehub_env_secrets SET payload = ${tampered} WHERE key = 'github'`);
      await expect(store.secrets.read("github")).rejects.toMatchObject({ code: "SEAL_INVALID" });
    }
  });

  it("reads legacy iv:ct rows with any configured key and rotates them", async () => {
    const db = database();
    const store = createDatabaseEnvStore({ db, encryptionKeys: [keyB, keyA] });
    await store.secrets.inspect("github");
    const legacy = await sealWithKey(await importSealKey(keyA), aad("default", "github", "rev-1"), "legacy-token");
    await db.run(
      sql`INSERT INTO vitehub_env_secrets (namespace, key, payload, revision, updated_at, preview) VALUES ('default', 'github', ${legacy}, 'rev-1', ${new Date().toISOString()}, NULL)`,
    );
    expect(await store.secrets.read("github")).toEqual({ value: "legacy-token", revision: "rev-1" });
    await expect(createDatabaseEnvStore({ db, encryptionKeys: [keyC] }).secrets.read("github")).rejects.toMatchObject({
      code: "SEAL_INVALID",
    });

    expect(await store.rotate()).toEqual({ rotated: 1, skipped: 0 });
    expect(await payload(db, "github")).toMatch(new RegExp(`^v2:${await sealKeyId(keyB)}:`));
    expect(await createDatabaseEnvStore({ db, encryptionKeys: [keyB] }).secrets.read("github")).toEqual({
      value: "legacy-token",
      revision: "rev-1",
    });
  });

  it("keeps a write that lands while rotation re-encrypts the row", async () => {
    const db = database();
    const old = createDatabaseEnvStore({ db, encryptionKeys: [keyA] });
    const first = await old.secrets.replace({ key: "github", value: "old-token", expectedRevision: null });
    let newer: string | undefined;
    const racing: EnvDatabase = {
      run: (query) => db.run(query),
      async all(query: SQL) {
        const text = dialect.sqlToQuery(query).sql;
        if (newer === undefined && /^update "?vitehub_env_secrets"? set payload = \?( |,)?\s*where/i.test(text)) {
          const written = await createDatabaseEnvStore({ db, encryptionKeys: [keyB, keyA] }).secrets.replace({
            key: "github",
            value: "new-token",
            expectedRevision: first.revision,
          });
          newer = written.revision;
        }
        return db.all(query);
      },
    };
    const rotating = createDatabaseEnvStore({ db: racing, encryptionKeys: [keyB, keyA] });
    expect(await rotating.rotate()).toEqual({ rotated: 0, skipped: 1 });
    expect(newer).toBeDefined();
    expect(await createDatabaseEnvStore({ db, encryptionKeys: [keyB] }).secrets.read("github")).toEqual({
      value: "new-token",
      revision: newer,
    });
  });

  it("requires at least one 32-byte key", () => {
    expect(() => createDatabaseEnvStore({ db: database(), encryptionKeys: [] })).toThrow(
      expect.objectContaining({ code: "ENV_BRIDGE_INVALID" }),
    );
    expect(() => createDatabaseEnvStore({ db: database(), encryptionKeys: [keyA, new Uint8Array(16)] })).toThrow(
      expect.objectContaining({ code: "ENV_BRIDGE_INVALID" }),
    );
  });
});
