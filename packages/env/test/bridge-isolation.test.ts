import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvBridge, type EnvAccessContext } from "../src/bridge.ts";
import { createDatabaseEnvStore } from "../src/database.ts";
import { env } from "../src/core/declarations.ts";
import { createRuntimeRegistry } from "../src/core/resolve.ts";
import { loadServerEnv } from "../src/server.ts";
import { SecretEnv } from "../src/secret.ts";

const admin: EnvAccessContext = { actor: { kind: "user", id: "owner" }, admin: true };
const agent: EnvAccessContext = {
  actor: { kind: "agent", id: "runner" },
  traceId: "trace-request",
  invocationId: "invocation-request",
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function setup() {
  const client = createClient({ url: ":memory:" });
  cleanup.push(() => client.close());
  const db = drizzle(client);
  const runtimeContext = vi.fn(() => admin);
  function namespace(name: string, encryptionKey = new Uint8Array(32).fill(8)) {
    const store = createDatabaseEnvStore({ db, namespace: name, encryptionKey });
    return { store, bridge: createEnvBridge({ ...store, runtimeContext }) };
  }
  return { db, namespace, runtimeContext };
}

describe("Env Bridge storage and request isolation", () => {
  it("isolates credentials, grants, history and pagination cursors across namespaces", async () => {
    const { namespace } = setup();
    const first = namespace("first").bridge;
    const second = namespace("second").bridge;
    await first.replace(admin, { key: "token", value: "first-secret", expectedRevision: null });
    await second.replace(admin, { key: "token", value: "second-secret", expectedRevision: null });
    await first.grant(admin, { key: "token", actor: agent.actor, permissions: ["use"] });
    expect(await first.read({ env: {}, keys: ["token"], access: agent })).toEqual({
      token: "first-secret",
    });
    await expect(second.read({ env: {}, keys: ["token"], access: agent })).rejects.toMatchObject({
      code: "ENV_BRIDGE_DENIED",
    });
    expect(await second.read({ env: {}, keys: ["token"], access: admin })).toEqual({
      token: "second-secret",
    });
    expect(await second.grants(admin, "token")).toEqual([]);
    const events = await first.activity(admin, "token");
    const otherEvents = await second.activity(admin, "token");
    expect(events.every((event) => !otherEvents.some((other) => other.id === event.id))).toBe(true);
    expect(await second.activity(admin, "token", events[0]!.id)).toEqual([]);
  });

  it.each(["key", "namespace", "revision"] as const)(
    "rejects ciphertext transplanted to a different %s",
    async (field) => {
      const { db, namespace } = setup();
      const first = namespace("first").bridge;
      const second = namespace("second").bridge;
      await first.replace(admin, { key: "source", value: "source-secret", expectedRevision: null });
      await first.replace(admin, {
        key: "destination",
        value: "destination-secret",
        expectedRevision: null,
      });
      await second.replace(admin, { key: "source", value: "other-secret", expectedRevision: null });
      const [stored] = await db.all<{ payload: string; revision: string }>(
        sql`SELECT payload, revision FROM vitehub_env_secrets WHERE namespace = 'first' AND key = 'source'`,
      );
      const targetNamespace = field === "namespace" ? "second" : "first";
      const targetKey = field === "key" ? "destination" : "source";
      const revision = field === "revision" ? "modified-revision" : stored!.revision;
      await db.run(
        sql`UPDATE vitehub_env_secrets SET payload = ${stored!.payload}, revision = ${revision} WHERE namespace = ${targetNamespace} AND key = ${targetKey}`,
      );
      const target = field === "namespace" ? second : first;
      await expect(
        target.read({ env: {}, keys: [targetKey], access: admin }),
      ).rejects.toMatchObject({ code: "ENV_BRIDGE_OPERATION_FAILED" });
      const events = await target.activity(admin, targetKey);
      expect(events[0]).toMatchObject({ action: "resolve", outcome: "failed" });
      expect(JSON.stringify(events)).not.toContain("source-secret");
    },
  );

  it("requires the encryption key after restart and uses a fresh payload on replacement", async () => {
    const { db, namespace } = setup();
    const first = namespace("first").bridge;
    const initial = await first.replace(admin, {
      key: "token",
      value: "persistent-secret",
      expectedRevision: null,
    });
    const [before] = await db.all<{ payload: string }>(
      sql`SELECT payload FROM vitehub_env_secrets WHERE namespace = 'first' AND key = 'token'`,
    );
    await first.replace(admin, {
      key: "token",
      value: "persistent-secret",
      expectedRevision: initial.revision,
    });
    const [after] = await db.all<{ payload: string }>(
      sql`SELECT payload FROM vitehub_env_secrets WHERE namespace = 'first' AND key = 'token'`,
    );
    expect(after!.payload).not.toBe(before!.payload);
    expect(after!.payload.split(":")[0]).not.toBe(before!.payload.split(":")[0]);
    const wrongKey = namespace("first", new Uint8Array(32).fill(9)).bridge;
    await expect(wrongKey.read({ env: {}, keys: ["token"], access: admin })).rejects.toMatchObject({
      code: "ENV_BRIDGE_OPERATION_FAILED",
    });
    expect(
      await namespace("first").bridge.read({ env: {}, keys: ["token"], access: admin }),
    ).toEqual({ token: "persistent-secret" });
  });

  it("attributes Server Env loads to explicit request access and does not fall back to runtime authority", async () => {
    const { namespace, runtimeContext } = setup();
    const { bridge } = namespace("first");
    const replacement = await bridge.replace(admin, {
      key: "token",
      value: "request-secret",
      expectedRevision: null,
    });
    await bridge.grant(admin, { key: "token", actor: agent.actor, permissions: ["use"] });
    const registry = createRuntimeRegistry({
      token: env({ secret: true, source: env.provider("vault", "token") }),
    });
    const options = { providers: { vault: bridge }, access: agent };
    const loaded = await loadServerEnv<{ token: SecretEnv<string> }>(registry, undefined, options);
    expect(loaded.token.unseal()).toBe("request-secret");
    expect(runtimeContext).not.toHaveBeenCalled();
    const events = await bridge.activity(admin, "token");
    expect(events[0]).toMatchObject({
      action: "resolve",
      outcome: "succeeded",
      actor: agent.actor,
      traceId: agent.traceId,
      invocationId: agent.invocationId,
      revision: replacement.revision,
    });
    await expect(
      loadServerEnv(registry, undefined, { ...options, access: { ...agent, scope: [] } }),
    ).rejects.toBeDefined();
    expect(runtimeContext).not.toHaveBeenCalled();
    expect((await bridge.activity(admin, "token"))[0]).toMatchObject({
      action: "resolve",
      outcome: "denied",
      actor: agent.actor,
    });
  });
  it.each([
    { actor: { kind: "root", id: "runner" }, key: "token", permissions: ["use"] },
    { actor: { kind: "agent", id: "runner" }, key: "token", permissions: ["admin"] },
    { actor: { kind: "agent", id: "runner" }, key: "token", permissions: [] },
    { actor: { kind: "agent", id: "different" }, key: "token", permissions: ["use"] },
    { actor: { kind: "agent", id: "runner" }, key: "other", permissions: ["use"] },
    { actor: { kind: "agent", id: "" }, key: "token", permissions: ["use"] },
  ])("rejects invalid persisted grants before authorizing reads: %j", async (payload) => {
    const { db, namespace } = setup();
    const { bridge, store } = namespace("first");
    await bridge.replace(admin, { key: "token", value: "stored-secret", expectedRevision: null });
    await bridge.grant(admin, { key: "token", actor: agent.actor, permissions: ["use"] });
    await db.run(sql`UPDATE vitehub_env_grants SET payload = ${JSON.stringify(payload)}`);
    await expect(store.access.grants("token")).rejects.toBeDefined();
    await expect(bridge.read({ env: {}, keys: ["token"], access: agent })).rejects.toBeDefined();
  });

  it("validates persisted activity and its row identity before returning history", async () => {
    const { db, namespace } = setup();
    const { bridge, store } = namespace("first");
    await bridge.replace(admin, { key: "token", value: "stored-secret", expectedRevision: null });
    const event = (await bridge.activity(admin, "token"))[0]!;
    for (const payload of [
      { ...event, outcome: "invented" },
      { ...event, actor: { kind: "root", id: "owner" } },
      { ...event, permissions: ["admin"] },
      { ...event, id: "different" },
      { ...event, key: "other" },
      { ...event, timestamp: "yesterday" },
    ]) {
      await db.run(
        sql`UPDATE vitehub_env_activity SET payload = ${JSON.stringify(payload)} WHERE id = ${event.id}`,
      );
      await expect(store.access.activity({ key: "token", limit: 100 })).rejects.toBeDefined();
    }
    await db.run(sql`UPDATE vitehub_env_activity SET payload = '{' WHERE id = ${event.id}`);
    await expect(store.access.activity({ key: "token", limit: 100 })).rejects.toMatchObject({
      code: "ENV_BRIDGE_INVALID",
    });
  });

  it("validates secret rows before returning metadata or decrypting", async () => {
    const { db, namespace } = setup();
    const { bridge, store } = namespace("first");
    await bridge.replace(admin, { key: "token", value: "stored-secret", expectedRevision: null });
    await db.run(sql`UPDATE vitehub_env_secrets SET payload = 'malformed'`);
    await expect(store.secrets.inspect("token")).rejects.toBeDefined();
    await expect(bridge.read({ env: {}, keys: ["token"], access: admin })).rejects.toMatchObject({
      code: "ENV_BRIDGE_OPERATION_FAILED",
    });
  });
});
