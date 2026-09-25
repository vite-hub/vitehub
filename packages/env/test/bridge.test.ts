import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvBridge } from "../src/bridge.ts";
import { createDatabaseEnvStore } from "../src/database.ts";
import type { EnvAccessContext } from "../src/bridge.ts";

const admin: EnvAccessContext = { actor: { kind: "user", id: "owner" }, admin: true };
const agent: EnvAccessContext = {
  actor: { kind: "agent", id: "review" },
  traceId: "trace-1",
  invocationId: "run-1",
};
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
  const bridge = createEnvBridge({ ...store, runtimeContext: () => agent, emit });
  return { bridge, client, db, store, emit };
}

describe("Env Bridge", () => {
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
      bridge.use({ ...agent, scope: [] }, "key", "test", () => true),
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
      runtimeContext: () => admin,
    });
    await expect(bridge.read({ env: {}, keys: ["key"] })).rejects.toMatchObject({
      code: "ENV_BRIDGE_AUDIT_FAILED",
    });
    expect(read).not.toHaveBeenCalled();
  });
});
