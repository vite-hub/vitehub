import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogBuffer } from "../src/logs/memory.ts";
import { installLogSource } from "../src/logs/host.ts";
import logsRoute, { consoleLogsHandler } from "../src/console/runtime/server/logs.get.ts";
import { installConsoleAccess } from "../src/console/runtime/server/access.ts";
import { handleConsoleRpcRequest } from "./support/console-rpc.ts";
import type { LogPage, LogSource } from "../src/logs/source.ts";

const request = (query = "") => ({
  req: { method: "GET", url: `http://localhost/api/_vitehub/console/logs${query}` },
});
afterEach(() => installConsoleAccess({ mode: "open" }));
describe("Console Logs", () => {
  it("checks section access before querying a source", async () => {
    const buffer = createLogBuffer();
    const query = vi.spyOn(buffer.source, "query");
    installLogSource("/logs-tests", buffer.source);
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["kv"] }) });
    const response = await logsRoute(request());
    expect(response).toBeInstanceOf(Response);
    expect(response instanceof Response && response.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
  it("reads an existing source without initializing a logger", async () => {
    const buffer = createLogBuffer();
    buffer.append({
      id: "event",
      timestamp: "2026-10-28T12:00:00.000Z",
      level: "error",
      service: "api",
      message: "Failed",
      data: { error: { code: "TEST", fix: "Retry" } },
    });
    installLogSource("/logs-tests", buffer.source);
    const result = await consoleLogsHandler(request("?level=error&limit=1"));
    expect("page" in result && result.page.entries[0]?.data.error).toEqual({
      code: "TEST",
      fix: "Retry",
    });
    await expect(consoleLogsHandler(request("?limit=501"))).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(consoleLogsHandler(request("?cursor=expired"))).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it("rejects unsupported filters and hides backend failure details", async () => {
    const query = vi.fn().mockRejectedValue(new Error("private backend credential"));
    const source: LogSource = {
      info: {
        id: "external",
        label: "Existing backend",
        retention: { kind: "external", description: "Provider retention" },
        filters: [],
      },
      query,
    };
    installLogSource("/logs-tests", source);
    await expect(consoleLogsHandler(request("?text=hello"))).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(query).not.toHaveBeenCalled();
    await expect(consoleLogsHandler(request())).rejects.toMatchObject({
      statusCode: 502,
      message: "Could not read the log source.",
    });
  });
  it("reads Logs through the shared Console RPC transport", async () => {
    installConsoleAccess({ mode: "open" });
    const buffer = createLogBuffer();
    buffer.append({
      id: "rpc-event",
      timestamp: "2026-10-28T12:00:00.000Z",
      level: "info",
      service: "api",
      message: "Request completed",
      data: {},
    });
    installLogSource("/logs-rpc-tests", buffer.source);
    const response = await handleConsoleRpcRequest(
      new Request("http://localhost/_vitehub/rpc/__call", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vitehub-console": "1" },
        body: JSON.stringify({ operation: "logs.list", input: { limit: 1 } }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      value: { page: { entries: [{ id: "rpc-event" }] } },
    });
  });
  it.each(["HTTP", "RPC"])("cancels a pending source read when %s aborts", async (transport) => {
    installConsoleAccess({ mode: "open" });
    let markStarted!: (signal: AbortSignal | undefined) => void;
    const started = new Promise<AbortSignal | undefined>((resolve) => { markStarted = resolve; });
    let finish!: (page: LogPage) => void;
    const pending = new Promise<LogPage>((resolve) => { finish = resolve; });
    let aborted = false;
    const source: LogSource = {
      info: createLogBuffer().source.info,
      query: (_query, options) => {
        markStarted(options?.signal);
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          finish({ entries: [] });
        }, { once: true });
        return pending;
      },
    };
    installLogSource("/logs-abort-tests", source);
    const controller = new AbortController();
    const req = transport === "HTTP"
      ? new Request("http://localhost/api/_vitehub/console/logs", { signal: controller.signal })
      : new Request("http://localhost/_vitehub/rpc/__call", {
          method: "POST",
          headers: { "content-type": "application/json", "x-vitehub-console": "1" },
          body: JSON.stringify({ operation: "logs.list", input: {} }),
          signal: controller.signal,
        });
    const reading = transport === "HTTP" ? logsRoute({ req }) : handleConsoleRpcRequest(req);
    try {
      const signal = await started;
      controller.abort();
      expect(signal).toBe(req.signal);
      expect(aborted).toBe(true);
    } finally {
      finish({ entries: [] });
      await reading;
    }
  });
  it("bounds responses from external adapters", async () => {
    const source: LogSource = {
      info: {
        id: "external",
        label: "Existing backend",
        retention: { kind: "external", description: "Provider retention" },
        filters: [],
      },
      query: async () => ({
        entries: Array.from({ length: 201 }, (_, id) => ({
          id: String(id),
          timestamp: "2026-10-28T12:00:00.000Z",
          level: "info",
          service: "api",
          message: "Test",
          data: {},
        })),
      }),
    };
    installLogSource("/logs-tests", source);
    await expect(consoleLogsHandler(request())).rejects.toMatchObject({ statusCode: 502 });
  });
});
