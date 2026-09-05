import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
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
  const host = await createProcessAgentHost({ dataDir, capacity: { concurrency: 1 }, run });
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
