import { afterEach, describe, expect, it, vi } from "vitest";
import { createTraceEventLog } from "@vite-hub/runtime";
import { defineCapability, resolveAgentCapabilities } from "../src/capability-runtime.ts";
import { createAgentInvocationContextStore } from "../src/invocation-context.ts";

const runtime = () => ({
  capabilities: {},
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
});

describe("capability lifecycle timing", () => {
  afterEach(() => vi.restoreAllMocks());
  it("records actual callbacks with invocation correlation and no configuration or result bodies", async () => {
    let time = 100;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    const traceLog = createTraceEventLog({ content: "content" });
    const context = createAgentInvocationContextStore();
    context.set("agent.invocation.traceId", "invocation-1");
    const resolved = await resolveAgentCapabilities(
      {
        capabilities: [
          defineCapability({
            id: "example",
            metadata: { token: "private-value" },
            resolve() {
              time += 25;
            },
            close() {
              time += 7;
            },
          }),
        ],
      },
      { ...runtime(), traceLog, trace: { id: "trace-1" } },
      {},
      undefined,
      "read",
      { context },
    );
    await resolved.close();
    const events = traceLog.entries();
    expect(events.map((event) => event.name)).toEqual([
      "agent.capability.resolve",
      "agent.capability.close",
    ]);
    for (const event of events) {
      expect(event.attributes).toMatchObject({
        "agent.capability.id": "example",
        "agent.invocation.id": "invocation-1",
        "agent.capability.outcome": "success",
        "agent.capability.durationMs": expect.any(Number),
      });
      expect(event.trace).toEqual({ id: "trace-1" });
    }
    expect(events.map((event) => event.attributes?.["agent.capability.durationMs"])).toEqual([
      25, 7,
    ]);
    expect(JSON.stringify(events)).not.toContain("private-value");
  });

  it("records failures without serializing thrown secrets and still cleans up", async () => {
    const traceLog = createTraceEventLog({ content: "content" });
    const failure = new Error("token=private-value");
    const close = vi.fn();
    await expect(
      resolveAgentCapabilities(
        {
          capabilities: [
            defineCapability({
              id: "example",
              resolve() {
                throw failure;
              },
              close,
            }),
          ],
        },
        { ...runtime(), traceLog },
        {},
      ),
    ).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(
      traceLog.entries().map((event) => event.attributes?.["agent.capability.outcome"]),
    ).toEqual(["error", "success"]);
    expect(JSON.stringify(traceLog.entries())).not.toContain("private-value");
  });

  it("reports cancellation and preserves callback receivers and response short circuits", async () => {
    const traceLog = createTraceEventLog({ content: "content" });
    const abort = new AbortController();
    const reason = new Error("cancelled");
    const response = new Response("private-result");
    const resolved = await resolveAgentCapabilities(
      {
        capabilities: [
          defineCapability({
            id: "example",
            input() {
              expect(this.id).toBe("example");
              return response;
            },
            close() {
              abort.abort(reason);
              throw reason;
            },
          }),
        ],
      },
      { ...runtime(), traceLog },
      { abortSignal: abort.signal },
    );
    expect(resolved.response).toBe(response);
    await expect(resolved.close()).rejects.toBe(reason);
    expect(
      traceLog.entries().map((event) => event.attributes?.["agent.capability.outcome"]),
    ).toEqual(["success", "cancelled"]);
    expect(JSON.stringify(traceLog.entries())).not.toContain("private-result");
  });

  it("does not fail callbacks when trace persistence fails", async () => {
    const traceLog = createTraceEventLog({ content: "content" });
    vi.spyOn(traceLog, "append").mockRejectedValue(new Error("unavailable"));
    const resolve = vi.fn();
    const close = vi.fn();
    const result = await resolveAgentCapabilities(
      { capabilities: [defineCapability({ id: "example", resolve, close })] },
      { ...runtime(), traceLog },
      {},
    );
    await result.close();
    expect(resolve).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
