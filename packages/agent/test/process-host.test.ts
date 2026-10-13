import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts";
import { createProcessAgentHost } from "../src/runtime/process.ts";

it("starts once and drains tracked work before closing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-process-host-"));
  let release!: () => void;
  const work = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn((_reason, { track }, accepting) => {
    expect(accepting()).toBe(true);
    track(work);
  });
  const host = await createProcessAgentHost({ dataDir: join(dataDir, "nested"), capacity: { concurrency: 1 }, run });
  try {
    expect(host.status()).toBe("starting");
    host.start();
    host.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    let closed = false;
    const close = host.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await close;
    expect(host.status()).toBe("drained");
    host.wake();
    host.start();
    expect(run).toHaveBeenCalledOnce();
    expect((await host.health()).workload.stale).toBe(0);
  } finally {
    release();
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("uses a shared journal and recovers only the configured Agent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-shared-process-host-"));
  const store = createMemoryAgentInvocationStore();
  for (const [id, agentName] of [["owned", "worker"], ["other", "another-agent"]] as const) {
    await store.create({
      agentName,
      createdAt: "2020-01-01T00:00:00.000Z",
      id,
      observations: [],
      status: "running",
      traceId: id,
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
  }
  const invocations = defineAgentInvocations({ content: "content", store });
  const host = await createProcessAgentHost({
    dataDir,
    invocations,
    invocationAgentName: "worker",
    capacity: { concurrency: 1 },
    run: vi.fn(),
  });
  try {
    expect(host.invocations).toBe(invocations);
    await expect(host.invocations.get("owned")).resolves.toMatchObject({ status: "failed" });
    await expect(host.invocations.get("other")).resolves.toMatchObject({ status: "running" });
    await expect(stat(join(dataDir, "invocations.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(host.health()).resolves.toMatchObject({ workload: { stale: 0, total: 1 } });
  } finally {
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("keeps another Babysitter host's live work when a shared-journal host restarts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-babysitter-hosts-"));
  const store = createMemoryAgentInvocationStore();
  const invocations = defineAgentInvocations({ content: "content", store });
  const options = { invocations, capacity: { concurrency: 1 }, run: vi.fn() };
  const first = await createProcessAgentHost({ ...options, dataDir: join(dataDir, "first"), invocationAgentName: "first-worker" });
  try {
    for (const agentName of ["first-worker", "second-worker"]) {
      await store.create({
        id: agentName, agentName, traceId: agentName, observations: [], status: "running",
        createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
      });
    }
    expect(await store.claim("first-worker", "live-claim", 60_000)).toBe(true);
    const liveClaimToken = await store.getClaimToken("first-worker");
    expect(liveClaimToken).toBeDefined();
    const second = await createProcessAgentHost({ ...options, dataDir: join(dataDir, "second"), invocationAgentName: "second-worker" });
    try {
      await expect(invocations.get("first-worker")).resolves.toMatchObject({ status: "running" });
      expect(await store.getClaimToken("first-worker")).toBe(liveClaimToken);
      await expect(invocations.get("second-worker")).resolves.toMatchObject({ status: "failed" });
      await expect(second.health()).resolves.toMatchObject({ workload: { total: 1, failed: 1, stale: 0 } });
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
