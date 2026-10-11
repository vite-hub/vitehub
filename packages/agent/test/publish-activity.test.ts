import { expect, it, vi } from "vitest";
vi.mock("#vitehub/agent/registry", () => ({ default: {} }));

import { publishAgentActivity } from "../src/index.ts";
import { github } from "../src/channels.ts";

it("publishes a deterministic wait without resolving an agent or starting a provider", async () => {
  const update = vi.fn();
  const resolve = vi.fn(() => {
    throw new Error("must not start a provider");
  });
  const agent = {
    name: "worker",
    resolve,
    channels: { github: { kind: "github", activity: { update } } },
  };
  await publishAgentActivity(agent, {
    channelId: "github",
    target: { repository: "acme/app", issue: 1 },
    activity: {
      runId: "wait:head",
      status: "queued",
      links: [],
      tasks: [],
      summary: "Waiting for checks.",
    },
  });
  expect(resolve).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      activity: expect.objectContaining({ summary: "Waiting for checks.", agentName: "worker" }),
    }),
  );
});

it("does not retain one-shot waiting publications as active invocation runs", async () => {
  let body = "";
  const channel = github({ activity: true, app: { token: "test-token", apiBaseUrl: "https://one-shot-activity.example.test", identity: { login: "worker[bot]" }, fetch: async (_input, init) => {
    if (!init?.method || init.method === "GET") return Response.json(body ? [{ id: 7, body, user: { login: "worker[bot]" } }] : []);
    body = JSON.parse(String(init.body)).body;
    return Response.json({ id: 7 });
  } } });
  const agent = { name: "worker", channels: { github: channel } };
  const publish = (runId: string, status: "waiting" | "completed", summary: string) => publishAgentActivity(agent, {
    channelId: "github", target: { repository: "acme/app", issue: 7 },
    activity: { runId, status, links: [], tasks: [], summary },
  });
  await publish("one-shot-wait", "waiting", "Original wait");
  for (let index = 0; index < 101; index++) await publish(`later-${index}`, "completed", "Later result");
  await publish("one-shot-wait", "waiting", "Current replay");
  expect(body).toContain("Current replay");
});
