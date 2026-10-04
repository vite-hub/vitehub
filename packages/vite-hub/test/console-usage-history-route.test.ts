import { consoleRpcHeader, consoleRpcMethods } from "../src/console/runtime/rpc.ts";
import { handleConsoleRpcRequest } from "../src/console/runtime/server/rpc.ts";
import { expect, it } from "vitest";
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server";
import { installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts";
import usageHandler from "../src/console/runtime/server/usage.get.ts";

it("validates session history filters and keeps filtered responses separate in the cache", async () => {
  const store = createMemoryAgentInvocationStore();
  const timestamp = new Date().toISOString();
  for (const [id, status, title] of [
    ["finished", "completed", "Release"],
    ["failed", "failed", "Investigate"],
  ] as const) {
    await store.create({
      id,
      agentName: "history",
      status,
      title,
      createdAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
      traceId: id,
      observations: [],
    });
  }
  const invocations = defineAgentInvocations({ store });
  installConsoleAgentDefinitions(
    [
      {
        definition: {
          invocations,
          async resolve() {
            throw new Error("History inspection must not invoke the Agent");
          },
        },
        fallbackName: "history",
      },
    ],
    { projectRoot: process.cwd(), invoke: false },
  );
  const request = (query: string) =>
    usageHandler({
      method: "GET",
      req: { url: `http://localhost/api/_vitehub/console/usage?${query}` },
    });
  expect(await request("status=failed")).toMatchObject({
    sessionCount: 1,
    sessions: [{ id: "failed" }],
    totals: { invocations: 1 },
  });
  expect(await request("search=release")).toMatchObject({
    sessionCount: 1,
    sessions: [{ id: "finished" }],
    totals: { invocations: 1 },
  });
  expect(await request("")).toMatchObject({ sessionCount: 2, totals: { invocations: 2 } });
  await expect(request("cursor=50")).rejects.toMatchObject({ statusCode: 400 });
  await expect(request("cursor=%25")).rejects.toMatchObject({ statusCode: 400 });
  await expect(request("status=running")).rejects.toMatchObject({
    statusCode: 400,
    statusMessage: "Invalid usage status",
  });
  const rpcResponse = await handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/__call", {
    body: JSON.stringify({ input: { query: { status: "running" } }, method: consoleRpcMethods.usage }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
  }));
  await expect(rpcResponse.json()).resolves.toEqual({ message: "Invalid usage status", ok: false, status: 400 });
  await expect(request(`search=${"x".repeat(513)}`)).rejects.toMatchObject({ statusCode: 400, statusMessage: "Invalid usage search" });
});


it.each(["100%_", "%41", "雪% &+?#"])(
  "round-trips history cursors through HTTP and RPC with filter %s",
  async (filter) => {
    const store = createMemoryAgentInvocationStore();
    const timestamp = new Date().toISOString();
    for (let i = 0; i < 51; i++) {
      const id = `session-${String(i).padStart(2, "0")}`;
      await store.create({
        id, agentName: filter, title: filter, status: "completed",
        createdAt: timestamp, completedAt: timestamp, updatedAt: timestamp,
        traceId: id, observations: [],
      });
    }
    const invocations = defineAgentInvocations({ store });
    installConsoleAgentDefinitions([{
      definition: {
        invocations,
        async resolve() { throw new Error("History must not invoke the Agent"); },
      },
      fallbackName: filter,
    }], { projectRoot: process.cwd(), invoke: false });
    const query = { agent: filter, search: filter };
    const request = (queryString: string) => usageHandler({
      method: "GET",
      req: { url: `http://localhost/api/_vitehub/console/usage?${queryString}` },
    });
    const first = await request(new URLSearchParams(query).toString());
    expect(first.sessions).toHaveLength(50);
    expect(first.cursor).toEqual(expect.any(String));
    const cursor = String(first.cursor);
    const expected = { sessions: [{ id: "session-00" }], from: first.from, to: first.to };
    // Direct HTTP callers paste the returned opaque token into the raw URL.
    expect(await request(`${new URLSearchParams(query)}&cursor=${cursor}`)).toMatchObject(expected);
    const response = await handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/__call", {
      body: JSON.stringify({ input: { query: { ...query, cursor } }, method: consoleRpcMethods.usage }),
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
      method: "POST",
    }));
    expect(await response.json()).toMatchObject({ ok: true, value: expected });
  },
);
