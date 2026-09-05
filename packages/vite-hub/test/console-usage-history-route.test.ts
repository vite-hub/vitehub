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
  await expect(request("status=running")).rejects.toMatchObject({ statusCode: 400 });
  await expect(request(`search=${"x".repeat(513)}`)).rejects.toMatchObject({ statusCode: 400 });
});
