import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvBridge } from "../src/bridge.ts";
import { createDatabaseEnvStore } from "../src/database.ts";
import { agentEnvAccess } from "./agent-access.ts";
import { connectionEnvAccess } from "../src/internal/connections.ts";
import type { EnvAccessContext } from "../src/bridge.ts";
import { adminContext, agentTokenContext } from "./helpers.ts";

const admin = await adminContext();
const attribution = { traceId: "trace-1", invocationId: "run-1" };
const agent = agentEnvAccess({ name: "review" }, attribution);
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function setup(url = ":memory:") {
  const client = createClient({ url });
  cleanup.push(() => client.close());
  const db = drizzle(client);
  const store = createDatabaseEnvStore({
    db,
    encryptionKey: new Uint8Array(32).fill(7),
    previews: true,
  });
  const emit = vi.fn();
  const bridge = createEnvBridge({ ...store, runtimeActor: agent.actor, runtimeAttribution: () => attribution, emit });
  return { bridge, client, db, store, emit };
}

describe("Env Bridge", () => {
  it("passes the leased secret revision to use and its audit event", async () => {
    const { bridge } = setup();
    const first = await bridge.replace(admin, { key: "github", value: "first", expectedRevision: null });
    const leased = await bridge.use(admin, "github", "revoke", async (secret, metadata) => {
      await bridge.replace(admin, { key: "github", value: "second", expectedRevision: first.revision });
      return { value: secret.unseal(), revision: metadata?.revision };
    });
    expect(leased).toEqual({ value: "first", revision: first.revision });
    expect(await bridge.activity(admin, "github")).toContainEqual(expect.objectContaining({ action: "use", operation: "revoke", outcome: "succeeded", revision: first.revision }));
  });
  it("rejects invalid acting actor kinds without corrupting durable activity", async () => {
    const { bridge, db, store, emit } = setup();
    const invalid = { actor: { id: "owner", kind: "other" }, admin: true } as unknown as EnvAccessContext;
    await expect(bridge.replace(invalid, { key: "github", value: "secret", expectedRevision: null })).rejects.toMatchObject({ code: "ENV_BRIDGE_UNTRUSTED" });
    await expect(bridge.permissions(invalid, "github")).rejects.toMatchObject({ code: "ENV_BRIDGE_UNTRUSTED" });
    expect(() => agentEnvAccess({ name: "" })).toThrow(expect.objectContaining({ code: "ENV_BRIDGE_INVALID" }));
    const runtime = createEnvBridge({ ...store, runtimeActor: invalid.actor });
    await expect(runtime.read({ env: {}, keys: ["github"] })).rejects.toMatchObject({ code: "ENV_BRIDGE_INVALID" });
    expect(await bridge.activity(admin, "github")).toEqual([]);
    expect(await db.all(sql`SELECT * FROM vitehub_env_activity`)).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });
  it("persists encrypted replacements, resolves the new revision, and separates previews from inspection", async () => {
    const { bridge, db } = setup();
    const first = await bridge.replace(admin, {
      key: "github",
      value: "ghp_first_secret_1234",
      expectedRevision: null,
    });
    expect(first.activation).toBe("next-resolution");
    await bridge.grant(admin, {
      actor: agent.actor,
      key: "github",
      permissions: ["use", "inspect"],
    });
    expect(await bridge.read({ env: {}, keys: ["github"] })).toEqual({
      github: "ghp_first_secret_1234",
    });
    expect(await bridge.inspect(agent, "github")).not.toHaveProperty("preview");
    await expect(bridge.preview(agent, "github")).rejects.toMatchObject({
      code: "ENV_BRIDGE_DENIED",
    });
    expect(await bridge.preview(admin, "github")).toMatchObject({ preview: "ghp_••••1234" });
    await bridge.grant(admin, { actor: agent.actor, key: "github", permissions: ["preview"] });
    expect(await bridge.preview(agent, "github")).toEqual({ preview: "ghp_••••1234" });
    await expect(bridge.inspect(agent, "github")).rejects.toMatchObject({ code: "ENV_BRIDGE_DENIED" });
    await bridge.grant(admin, { actor: agent.actor, key: "github", permissions: ["use", "inspect"] });
    await bridge.replace(admin, {
      key: "github",
      value: "ghp_second_secret_5678",
      expectedRevision: first.revision,
    });
    expect(await bridge.read({ env: {}, keys: ["github"] })).toEqual({
      github: "ghp_second_secret_5678",
    });
    expect(JSON.stringify(await db.all(sql`SELECT * FROM vitehub_env_secrets`))).not.toContain(
      "second_secret",
    );
    const events = await bridge.activity(admin, "github");
    expect(
      events.some(
        (event) =>
          event.action === "resolve" &&
          event.outcome === "succeeded" &&
          event.invocationId === "run-1" &&
          event.revision,
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("ghp_");
  });
  it("records actual operation outcomes and sanitizes errors and exporter failures", async () => {
    const { bridge, emit } = setup();
    await bridge.replace(admin, { key: "github", value: "never-log-this", expectedRevision: null });
    await bridge.grant(admin, { actor: agent.actor, key: "github", permissions: ["use"] });
    emit.mockRejectedValue(new Error("Exporter offline"));
    await expect(
      bridge.use(agent, "github", "github.issues.list", (secret) => {
        expect(secret.unseal()).toBe("never-log-this");
        return [42];
      }),
    ).resolves.toEqual([42]);
    await expect(
      bridge.use(agent, "github", "github.issues.list", () => {
        throw new Error("never-log-this");
      }),
    ).rejects.toThrow("Env operation failed.");
    const events = await bridge.activity(admin, "github");
    expect(events.filter((event) => event.action === "use").map((event) => event.outcome)).toEqual([
      "failed",
      "started",
      "succeeded",
      "started",
    ]);
    expect(JSON.stringify(events)).not.toContain("never-log-this");
  });
  it("enforces grants, revocation and the authenticated token's permission ceiling", async () => {
    const { bridge } = setup();
    await bridge.replace(admin, { key: "key", value: "secret", expectedRevision: null });
    await expect(bridge.read({ env: {}, keys: ["key"] })).rejects.toMatchObject({
      code: "ENV_BRIDGE_DENIED",
    });
    await bridge.grant(admin, { actor: agent.actor, key: "key", permissions: ["use", "inspect"] });
    await expect(
      bridge.use(await agentTokenContext("review", []), "key", "test", () => true),
    ).rejects.toMatchObject({ code: "ENV_BRIDGE_DENIED" });
    await expect(
      bridge.grant(agent, { actor: agent.actor, key: "key", permissions: ["replace"] }),
    ).rejects.toMatchObject({ code: "ENV_BRIDGE_DENIED" });
    await bridge.revoke(admin, agent.actor, "key");
    await expect(bridge.use(agent, "key", "test", () => true)).rejects.toMatchObject({
      code: "ENV_BRIDGE_DENIED",
    });
    await expect(bridge.activity(agent, "key")).rejects.toMatchObject({
      code: "ENV_BRIDGE_DENIED",
    });
  });
  it("rejects stale and concurrent replacements atomically", async () => {
    const { bridge } = setup();
    const first = await bridge.replace(admin, {
      key: "key",
      value: "original",
      expectedRevision: null,
    });
    const results = await Promise.allSettled(
      ["one", "two"].map((value) =>
        bridge.replace(admin, { key: "key", value, expectedRevision: first.revision }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      bridge.replace(admin, { key: "key", value: "stale", expectedRevision: null }),
    ).rejects.toMatchObject({ code: "ENV_BRIDGE_CONFLICT" });
  });
  it("survives restart with values, grants and activity intact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "env-bridge-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "env.db")}`;
    const first = setup(url);
    await first.bridge.replace(admin, {
      key: "key",
      value: "persistent-secret",
      expectedRevision: null,
    });
    await first.bridge.grant(admin, { actor: agent.actor, key: "key", permissions: ["use"] });
    first.client.close();
    const second = setup(url);
    expect(await second.bridge.read({ env: {}, keys: ["key"] })).toEqual({
      key: "persistent-secret",
    });
    expect(
      (await second.bridge.activity(admin, "key")).some((event) => event.action === "replace"),
    ).toBe(true);
  });
  it("does not release secrets when the durable audit store is unavailable", async () => {
    const { store } = setup();
    const read = vi.fn(store.secrets.read);
    const bridge = createEnvBridge({
      secrets: { ...store.secrets, read },
      access: {
        ...store.access,
        append: async () => {
          throw new Error("offline");
        },
      },
      runtimeActor: agent.actor,
    });
    await expect(bridge.read({ env: {}, keys: ["key"] })).rejects.toMatchObject({
      code: "ENV_BRIDGE_AUDIT_FAILED",
    });
    expect(read).not.toHaveBeenCalled();
  });
});


it("limits custom-store previews to declared metadata", async () => {
  const { store } = setup();
  const bridge = createEnvBridge({ ...store, secrets: { ...store.secrets, inspect: async () => ({ revision: "v1", updatedAt: "now", preview: "test••••1234", value: "do-not-release" }) }, runtimeActor: agent.actor });
  expect(await bridge.preview(admin, "key")).toEqual({ preview: "test••••1234" });
});

it("sanitizes access-store failures in SDK authorization and history", async () => {
  const { store } = setup();
  const fail = async (): Promise<never> => { throw new Error("private-database-connection") };
  const bridge = createEnvBridge({ ...store, access: { ...store.access, grants: fail, activity: fail }, runtimeActor: agent.actor });
  for (const operation of [() => bridge.permissions(agent, "key"), () => bridge.read({ env: {}, keys: ["key"] }), () => bridge.activity(admin, "key"), () => bridge.grants(admin, "key")]) {
    await expect(operation()).rejects.toThrow("Env operation failed.");
  }
});

describe("Env access grants", () => {
  it("rejects administrator and actor contexts that Env did not create", async () => {
    const { bridge, emit } = setup();
    await bridge.replace(admin, { key: "github", value: "secret", expectedRevision: null });
    await bridge.grant(admin, { actor: agent.actor, key: "github", permissions: ["inspect", "use"] });
    const before = await bridge.activity(admin, "github");
    emit.mockClear();
    const forged = [
      { actor: admin.actor, admin: true },
      { ...admin },
      { ...admin, actor: { kind: "user", id: "other" } },
      JSON.parse(JSON.stringify(admin)),
      { actor: agent.actor },
      { actor: { kind: "agent", id: "review" }, traceId: "trace-1" },
      { ...agent },
      { ...agent, scope: [{ key: "github", permissions: ["use"] }] },
      Object.create(agent),
      JSON.parse(JSON.stringify(agent)),
    ] as unknown as EnvAccessContext[];
    for (const context of forged) {
      for (const operation of [
        () => bridge.replace(context, { key: "github", value: "secret", expectedRevision: null }),
        () => bridge.use(context, "github", "call", () => undefined),
        () => bridge.inspect(context, "github"),
        () => bridge.permissions(context, "github"),
        () => bridge.activity(context, "github"),
        () => bridge.grant(context, { actor: agent.actor, key: "github", permissions: ["use"] }),
        () => bridge.read({ env: {}, keys: ["github"], access: context }),
      ]) {
        await expect(operation()).rejects.toMatchObject({ code: "ENV_BRIDGE_UNTRUSTED" });
      }
    }
    expect(Object.isFrozen(admin) && Object.isFrozen(admin.actor)).toBe(true);
    expect(Object.isFrozen(agent) && Object.isFrozen(agent.actor)).toBe(true);
    expect(await bridge.activity(admin, "github")).toEqual(before);
    expect(emit).not.toHaveBeenCalled();
    expect(await bridge.use(agent, "github", "call", (value) => value.unseal())).toBe("secret");
  });

  it("gives an Agent context only the grants of its own Agent", async () => {
    const { bridge } = setup();
    await bridge.replace(admin, { key: "github", value: "secret", expectedRevision: null });
    await bridge.grant(admin, { actor: { kind: "agent", id: "deploy" }, key: "github", permissions: ["use"] });
    const review = agentEnvAccess({ name: "review" });
    await expect(bridge.use(review, "github", "call", () => undefined)).rejects.toMatchObject({ code: "ENV_BRIDGE_DENIED" });
    expect(await bridge.use(agentEnvAccess({ name: "deploy" }), "github", "call", (value) => value.unseal())).toBe("secret");
    await expect(bridge.grants(review, "github")).rejects.toMatchObject({ code: "ENV_BRIDGE_DENIED" });
    expect((await bridge.activity(admin, "github"))[0]).toMatchObject({ action: "use", actor: { kind: "agent", id: "deploy" } });
  });

  it("limits the runtime context to the actor and bridge of the runtime", async () => {
    const { bridge, store } = setup();
    await bridge.replace(admin, { key: "github", value: "secret", expectedRevision: null });
    const other = createEnvBridge({ ...store, runtimeActor: { kind: "service", id: "other" } });
    await expect(other.read({ env: {}, keys: ["github"] })).rejects.toMatchObject({ code: "ENV_BRIDGE_DENIED" });
    await bridge.grant(admin, { actor: agent.actor, key: "github", permissions: ["use"] });
    expect(await bridge.read({ env: {}, keys: ["github"] })).toEqual({ github: "secret" });
    expect((await bridge.activity(admin, "github"))[0]).toMatchObject({ action: "resolve", actor: agent.actor, outcome: "succeeded", invocationId: "run-1" });
  });

  it("limits a Connections context to its bridge, key, and permission", async () => {
    const { bridge, store } = setup();
    const other = createEnvBridge({ ...store, runtimeActor: agent.actor });
    const actor = { kind: "user", id: "connector" } as const;
    const replace = connectionEnvAccess(bridge, { actor, name: "gmail", permission: "replace" });
    const created = await bridge.replace(replace, { key: "connection/gmail", value: "token", expectedRevision: null });
    await expect(bridge.replace(replace, { key: "connection/other", value: "token", expectedRevision: null })).rejects.toMatchObject({ code: "ENV_BRIDGE_DENIED" });
    await expect(other.replace(replace, { key: "connection/gmail", value: "token", expectedRevision: created.revision })).rejects.toMatchObject({ code: "ENV_BRIDGE_DENIED" });
    await expect(bridge.use(replace, "connection/gmail", "call", () => undefined)).rejects.toMatchObject({ code: "ENV_BRIDGE_DENIED" });
    await expect(bridge.activity(replace, "connection/gmail")).rejects.toMatchObject({ code: "ENV_BRIDGE_DENIED" });
    await expect(bridge.grants(replace, "connection/gmail")).rejects.toMatchObject({ code: "ENV_BRIDGE_DENIED" });
    const use = connectionEnvAccess(bridge, { actor, name: "gmail", permission: "use", traceId: "trace-1" });
    expect(await bridge.use(use, "connection/gmail", "call", (secret) => secret.unseal())).toBe("token");
    await expect(bridge.use({ ...use }, "connection/gmail", "call", () => undefined)).rejects.toMatchObject({ code: "ENV_BRIDGE_UNTRUSTED" });
    const activity = connectionEnvAccess(bridge, { actor, name: "gmail", permission: "activity" });
    expect(await bridge.activity(activity, "connection/gmail")).toContainEqual(
      expect.objectContaining({ action: "use", actor, outcome: "succeeded", traceId: "trace-1" }),
    );
  });
});
