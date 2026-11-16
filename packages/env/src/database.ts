import { sql } from "drizzle-orm";
import * as v from "valibot";
import type { SQL } from "drizzle-orm";
import { envBridgeError } from "./bridge-error.ts";
import type { EnvAccessStore, EnvSecretMetadata, EnvSecretStore } from "./bridge.ts";
import { ViteHubError } from "@vite-hub/runtime";
import { importSealKey, sealedPayloadPattern, sealKeyId, sealWithKey, unsealWithKey } from "./seal.ts";
import type { SealKey } from "./seal.ts";

export interface EnvDatabase {
  run(query: SQL): unknown;
  all(query: SQL): unknown[] | PromiseLike<unknown[]>;
}
export interface DatabaseEnvStore {
  /** SQL predicate for atomically updating related records at a secret revision. */
  revisionCondition(key: string, revision: string | null): Promise<SQL>;
  /** The keys of the namespace with their metadata, by key. It never reads a value. */
  list(): Promise<(EnvSecretMetadata & { key: string })[]>;
  /** Delete a key. Returns `false` when the namespace has no such key. Activity and grants stay. */
  remove(key: string): Promise<boolean>;
  /**
   * Re-encrypts every value of the namespace that another key sealed with the current key, the first of
   * `encryptionKeys`. Revisions stay the same. A value that a write replaces during the rotation keeps the new write.
   */
  rotate(): Promise<EnvStoreRotation>;
  secrets: EnvSecretStore;
  access: EnvAccessStore;
}
/** The result of `DatabaseEnvStore.rotate()`. */
export interface EnvStoreRotation {
  /** Values re-encrypted with the current key. */
  rotated: number;
  /** Values that the current key already sealed, or that a concurrent write replaced. */
  skipped: number;
}
/** A stored value: `v2:<keyId>:<iv>:<ciphertext>`, or a legacy `<iv>:<ciphertext>` without a key id. */
const storedPayloadPattern = new RegExp(`^(?:v2:[a-f0-9]{16}:)?${sealedPayloadPattern.source.slice(1, -1)}$`);
const identifier = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
  // eslint-disable-next-line no-control-regex
  v.regex(/^[^\u0000-\u001f]+$/),
);
const actor = v.object({ id: identifier, kind: v.picklist(["user", "agent", "service"]) });
const permission = v.picklist(["inspect", "preview", "replace", "use"]);
const timestamp = v.pipe(v.string(), v.isoTimestamp());
const activity = v.object({
  id: identifier,
  operationId: identifier,
  timestamp,
  actor,
  key: identifier,
  action: v.picklist(["inspect", "preview", "replace", "remove", "resolve", "use", "grant", "revoke"]),
  outcome: v.picklist(["started", "succeeded", "failed", "denied"]),
  revision: v.optional(identifier),
  operation: v.optional(identifier),
  target: v.optional(actor),
  permissions: v.optional(v.array(permission)),
  traceId: v.optional(v.string()),
  invocationId: v.optional(v.string()),
});
const grant = v.object({
  actor,
  key: identifier,
  permissions: v.pipe(v.array(permission), v.minLength(1)),
});
const secretRow = v.object({
  payload: v.pipe(v.string(), v.regex(storedPayloadPattern)),
  revision: identifier,
  updated_at: timestamp,
  preview: v.nullable(v.string()),
});
const activityRow = v.object({ payload: v.string(), id: identifier });
const grantRow = v.object({
  payload: v.string(),
  actor_kind: v.picklist(["user", "agent", "service"]),
  actor_id: identifier,
});
const revisionRow = v.object({ revision: identifier });
const listRow = v.object({ key: identifier, revision: identifier, updated_at: timestamp, preview: v.nullable(v.string()) });
const namespaceRow = v.object({ namespace: v.string() });

/** Create the Env tables when they are missing. Each store and `listDatabaseEnvNamespaces()` calls it first. */
async function createEnvTables(db: EnvDatabase): Promise<void> {
  await db.run(
    sql`CREATE TABLE IF NOT EXISTS vitehub_env_secrets (namespace TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, revision TEXT NOT NULL, updated_at TEXT NOT NULL, preview TEXT, PRIMARY KEY (namespace, key))`,
  );
  await db.run(
    sql`CREATE TABLE IF NOT EXISTS vitehub_env_activity (sequence INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, key TEXT NOT NULL, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS vitehub_env_activity_key ON vitehub_env_activity (namespace, key, sequence)`,
  );
  await db.run(
    sql`CREATE TABLE IF NOT EXISTS vitehub_env_grants (namespace TEXT NOT NULL, key TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (namespace, key, actor_kind, actor_id))`,
  );
}

/**
 * The namespaces that start with `prefix` and hold at least one key, in text order. A Console that keeps one namespace
 * for each project and stage, such as `<project>:production`, finds the stages of a project with it.
 */
export async function listDatabaseEnvNamespaces(db: EnvDatabase, prefix: string): Promise<string[]> {
  await createEnvTables(db);
  const rows = await db.all(
    sql`SELECT DISTINCT namespace FROM vitehub_env_secrets WHERE substr(namespace, 1, ${prefix.length}) = ${prefix} ORDER BY namespace`,
  );
  return rows.map((row) => v.parse(namespaceRow, row).namespace);
}

const rotationRow = v.object({
  key: identifier,
  payload: v.pipe(v.string(), v.regex(storedPayloadPattern)),
  revision: identifier,
});
interface StoreKey {
  id: string;
  key: SealKey;
}

function parseStoredJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    throw envBridgeError("invalid");
  }
}

/**
 * Persistent encrypted values, activity, and grants on a ViteHub SQLite/Drizzle database.
 * `encryptionKeys` is the keyring: the current 32-byte key first, then previous keys that still decrypt older values.
 */
export function createDatabaseEnvStore(options: {
  db: EnvDatabase;
  encryptionKeys: readonly Uint8Array[];
  namespace?: string;
  previews?: boolean;
}): DatabaseEnvStore {
  if (!options.encryptionKeys.length || options.encryptionKeys.some((key) => key.byteLength !== 32))
    throw envBridgeError("invalid");
  const namespace = options.namespace ?? "default";
  let keyring: Promise<StoreKey[]> | undefined;
  const keys = () =>
    (keyring ??= Promise.all(
      options.encryptionKeys.map(async (key) => ({ id: await sealKeyId(key), key: await importSealKey(key) })),
    ));
  async function seal(key: string, revision: string, value: string): Promise<string> {
    const [current] = await keys();
    return `v2:${current!.id}:${await sealWithKey(current!.key, aad(key, revision), value)}`;
  }
  async function unseal(key: string, revision: string, payload: string): Promise<string> {
    const additionalData = aad(key, revision);
    if (payload.startsWith("v2:")) {
      const id = payload.slice(3, 19);
      const match = (await keys()).find((candidate) => candidate.id === id);
      if (!match)
        throw new ViteHubError(
          "SEAL_INVALID",
          `No configured encryption key has the key id ${id}. Add the key that sealed this value to the keyring.`,
        );
      return await unsealWithKey(match.key, additionalData, payload.slice(20));
    }
    // A legacy value has no key id. Try the current key, then each previous key.
    let failure: unknown;
    for (const candidate of await keys()) {
      try {
        return await unsealWithKey(candidate.key, additionalData, payload);
      } catch (error) {
        failure ??= error;
      }
    }
    throw failure;
  }
  let ready: Promise<void> | undefined;
  const initialize = () =>
    (ready ??= createEnvTables(options.db).catch((error: unknown) => {
      ready = undefined;
      throw error;
    }));
  async function row(key: string): Promise<v.InferOutput<typeof secretRow> | undefined> {
    await initialize();
    const stored = (
      await options.db.all(
        sql`SELECT payload, revision, updated_at, preview FROM vitehub_env_secrets WHERE namespace = ${namespace} AND key = ${key}`,
      )
    )[0];
    return stored === undefined ? undefined : v.parse(secretRow, stored);
  }
  function aad(key: string, revision: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify([namespace, key, revision]));
  }
  return {
    async rotate() {
      await initialize();
      const [current] = await keys();
      const rows = await options.db.all(
        sql`SELECT key, payload, revision FROM vitehub_env_secrets WHERE namespace = ${namespace} ORDER BY key`,
      );
      let rotated = 0;
      let skipped = 0;
      for (const row of rows) {
        const stored = v.parse(rotationRow, row);
        if (stored.payload.startsWith(`v2:${current!.id}:`)) {
          skipped++;
          continue;
        }
        const value = await unseal(stored.key, stored.revision, stored.payload);
        const payload = await seal(stored.key, stored.revision, value);
        // The row must still hold the value that was read. A write in between wins and already uses the current key.
        const written = await options.db.all(
          sql`UPDATE vitehub_env_secrets SET payload = ${payload} WHERE namespace = ${namespace} AND key = ${stored.key} AND revision = ${stored.revision} AND payload = ${stored.payload} RETURNING key`,
        );
        if (written.length) rotated++;
        else skipped++;
      }
      return { rotated, skipped };
    },
    async revisionCondition(key, revision) {
      await initialize();
      return revision === null
        ? sql`NOT EXISTS (SELECT 1 FROM vitehub_env_secrets WHERE namespace = ${namespace} AND key = ${key})`
        : sql`EXISTS (SELECT 1 FROM vitehub_env_secrets WHERE namespace = ${namespace} AND key = ${key} AND revision = ${revision})`;
    },
    async list() {
      await initialize();
      const rows = await options.db.all(
        sql`SELECT key, revision, updated_at, preview FROM vitehub_env_secrets WHERE namespace = ${namespace} ORDER BY key`,
      );
      return rows.map((row) => {
        const stored = v.parse(listRow, row);
        return {
          key: stored.key,
          revision: stored.revision,
          updatedAt: stored.updated_at,
          ...(stored.preview ? { preview: stored.preview } : {}),
        };
      });
    },
    async remove(key) {
      await initialize();
      const removed = await options.db.all(
        sql`DELETE FROM vitehub_env_secrets WHERE namespace = ${namespace} AND key = ${key} RETURNING revision`,
      );
      return removed.length > 0;
    },
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
        const value = await unseal(key, stored.revision, stored.payload);
        return { value, revision: stored.revision };
      },
      async replace({ key, value, expectedRevision }) {
        await initialize();
        const revision = crypto.randomUUID();
        const updatedAt = new Date().toISOString();
        const payload = await seal(key, revision, value);
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
        if (written.length !== 1 || v.parse(revisionRow, written[0]).revision !== revision)
          throw envBridgeError("invalid");
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
        const rows = await options.db.all(
          sql`SELECT payload, id FROM vitehub_env_activity WHERE namespace = ${namespace} AND key = ${key} ${before ? sql`AND sequence < (SELECT sequence FROM vitehub_env_activity WHERE id = ${before} AND namespace = ${namespace} AND key = ${key})` : sql``} ORDER BY sequence DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`,
        );
        return rows.map((row) => {
          const stored = v.parse(activityRow, row);
          const event = v.parse(activity, parseStoredJson(stored.payload));
          if (event.key !== key || event.id !== stored.id) throw envBridgeError("invalid");
          return event;
        });
      },
      async grants(key) {
        await initialize();
        const rows = await options.db.all(
          sql`SELECT payload, actor_kind, actor_id FROM vitehub_env_grants WHERE namespace = ${namespace} AND key = ${key} ORDER BY actor_kind, actor_id`,
        );
        return rows.map((row) => {
          const stored = v.parse(grantRow, row);
          const access = v.parse(grant, parseStoredJson(stored.payload));
          if (
            access.key !== key ||
            access.actor.kind !== stored.actor_kind ||
            access.actor.id !== stored.actor_id
          )
            throw envBridgeError("invalid");
          return access;
        });
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
