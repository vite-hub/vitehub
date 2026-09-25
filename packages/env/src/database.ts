import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { envBridgeError } from "./bridge-error.ts";
import type { EnvAccessStore, EnvActivity, EnvGrant, EnvSecretStore } from "./bridge.ts";

export interface EnvDatabase {
  run(query: SQL): unknown;
  all<T extends Record<string, unknown>>(query: SQL): T[] | PromiseLike<T[]>;
}
export interface DatabaseEnvStore {
  secrets: EnvSecretStore;
  access: EnvAccessStore;
}
interface SecretRow extends Record<string, unknown> {
  payload: string;
  revision: string;
  updated_at: string;
  preview: string | null;
}
interface JSONRow extends Record<string, unknown> {
  payload: string;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[a-f0-9]{2})+$/.test(value)) throw envBridgeError("invalid");
  return Uint8Array.from(value.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

/** Persistent encrypted values, activity, and grants on a ViteHub SQLite/Drizzle database. */
export function createDatabaseEnvStore(options: {
  db: EnvDatabase;
  encryptionKey: Uint8Array;
  namespace?: string;
  previews?: boolean;
}): DatabaseEnvStore {
  if (options.encryptionKey.byteLength !== 32) throw envBridgeError("invalid");
  const namespace = options.namespace ?? "default";
  const encryptionKey = crypto.subtle.importKey(
    "raw",
    new Uint8Array(options.encryptionKey),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  let ready: Promise<void> | undefined;
  const initialize = () =>
    (ready ??= (async () => {
      await options.db.run(
        sql`CREATE TABLE IF NOT EXISTS vitehub_env_secrets (namespace TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, revision TEXT NOT NULL, updated_at TEXT NOT NULL, preview TEXT, PRIMARY KEY (namespace, key))`,
      );
      await options.db.run(
        sql`CREATE TABLE IF NOT EXISTS vitehub_env_activity (sequence INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, key TEXT NOT NULL, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)`,
      );
      await options.db.run(
        sql`CREATE INDEX IF NOT EXISTS vitehub_env_activity_key ON vitehub_env_activity (namespace, key, sequence)`,
      );
      await options.db.run(
        sql`CREATE TABLE IF NOT EXISTS vitehub_env_grants (namespace TEXT NOT NULL, key TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (namespace, key, actor_kind, actor_id))`,
      );
    })().catch((error) => {
      ready = undefined;
      throw error;
    }));
  async function row(key: string): Promise<SecretRow | undefined> {
    await initialize();
    return (
      await options.db.all<SecretRow>(
        sql`SELECT payload, revision, updated_at, preview FROM vitehub_env_secrets WHERE namespace = ${namespace} AND key = ${key}`,
      )
    )[0];
  }
  function aad(key: string, revision: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify([namespace, key, revision]));
  }
  return {
    secrets: {
      async inspect(key) {
        const stored = await row(key);
        return stored
          ? {
              revision: stored.revision,
              updatedAt: stored.updated_at,
              ...(stored.preview ? { preview: stored.preview } : {}),
            }
          : undefined;
      },
      async read(key) {
        const stored = await row(key);
        if (!stored) return;
        const [iv, ciphertext] = stored.payload.split(":");
        const value = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bytes(iv!), additionalData: aad(key, stored.revision) },
          await encryptionKey,
          bytes(ciphertext!),
        );
        return { value: new TextDecoder().decode(value), revision: stored.revision };
      },
      async replace({ key, value, expectedRevision }) {
        await initialize();
        const revision = crypto.randomUUID();
        const updatedAt = new Date().toISOString();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aad(key, revision) },
          await encryptionKey,
          new TextEncoder().encode(value),
        );
        const payload = `${hex(iv)}:${hex(new Uint8Array(encrypted))}`;
        const preview =
          options.previews && value.length > 12 && /^[A-Za-z0-9_.-]+$/.test(value)
            ? `${value.slice(0, 4)}••••${value.slice(-4)}`
            : null;
        const written =
          expectedRevision === null
            ? await options.db.all(
                sql`INSERT INTO vitehub_env_secrets (namespace, key, payload, revision, updated_at, preview) VALUES (${namespace}, ${key}, ${payload}, ${revision}, ${updatedAt}, ${preview}) ON CONFLICT (namespace, key) DO NOTHING RETURNING revision`,
              )
            : await options.db.all(
                sql`UPDATE vitehub_env_secrets SET payload = ${payload}, revision = ${revision}, updated_at = ${updatedAt}, preview = ${preview} WHERE namespace = ${namespace} AND key = ${key} AND revision = ${expectedRevision} RETURNING revision`,
              );
        if (!written.length) throw envBridgeError("conflict");
        return {
          revision,
          updatedAt,
          activation: "next-resolution",
          ...(preview ? { preview } : {}),
        };
      },
    },
    access: {
      async append(event) {
        await initialize();
        await options.db.run(
          sql`INSERT INTO vitehub_env_activity (namespace, key, id, payload) VALUES (${namespace}, ${event.key}, ${event.id}, ${JSON.stringify(event)})`,
        );
      },
      async activity({ key, before, limit }) {
        await initialize();
        const rows = await options.db.all<JSONRow>(
          sql`SELECT payload FROM vitehub_env_activity WHERE namespace = ${namespace} AND key = ${key} ${before ? sql`AND sequence < (SELECT sequence FROM vitehub_env_activity WHERE id = ${before} AND namespace = ${namespace} AND key = ${key})` : sql``} ORDER BY sequence DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`,
        );
        return rows.map((row) => JSON.parse(row.payload) as EnvActivity);
      },
      async grants(key) {
        await initialize();
        const rows = await options.db.all<JSONRow>(
          sql`SELECT payload FROM vitehub_env_grants WHERE namespace = ${namespace} AND key = ${key} ORDER BY actor_kind, actor_id`,
        );
        return rows.map((row) => JSON.parse(row.payload) as EnvGrant);
      },
      async setGrant(grant) {
        await initialize();
        await options.db.run(
          sql`INSERT INTO vitehub_env_grants (namespace, key, actor_kind, actor_id, payload) VALUES (${namespace}, ${grant.key}, ${grant.actor.kind}, ${grant.actor.id}, ${JSON.stringify(grant)}) ON CONFLICT (namespace, key, actor_kind, actor_id) DO UPDATE SET payload = excluded.payload`,
        );
      },
      async revokeGrant(actor, key) {
        await initialize();
        await options.db.run(
          sql`DELETE FROM vitehub_env_grants WHERE namespace = ${namespace} AND key = ${key} AND actor_kind = ${actor.kind} AND actor_id = ${actor.id}`,
        );
      },
    },
  };
}
