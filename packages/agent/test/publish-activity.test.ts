import { expect, it, vi } from "vitest";
import { publishAgentActivity } from "../src/index.ts";

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
