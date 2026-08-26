import { describe, expect, it } from "vitest";

import {
  agentInvocationContext,
  agentInvocationExternalUrl,
  agentInvocationProject,
  agentInvocationTitle,
} from "../src/invocation-display.ts";

describe("Agent Invocation display", () => {
  const invocation = {
    agentName: "babysitter",
    annotations: {
      "github.pullRequest": 1031,
      "github.repository": "vite-hub/vitehub",
      "github.title": "Recover invalid model output",
      "github.url": "https://github.com/vite-hub/vitehub/pull/1031",
    },
    id: "invocation-1",
  };

  it("gives the Console and Invocation renderer the same labels", () => {
    expect(agentInvocationTitle(invocation)).toBe("Recover invalid model output");
    expect(agentInvocationProject(invocation)).toBe("vitehub");
    expect(agentInvocationContext(invocation)).toBe("vite-hub/vitehub · PR #1031");
    expect(agentInvocationExternalUrl(invocation)).toBe(
      "https://github.com/vite-hub/vitehub/pull/1031",
    );
  });

  it("falls back to generic Agent Invocation fields", () => {
    expect(agentInvocationTitle({ agentName: "calories", id: "invocation-2" })).toBe("calories");
    expect(
      agentInvocationProject({
        agentName: "calories",
        configuration: { workspace: { name: "Meals" } },
        id: "invocation-2",
      }),
    ).toBe("Meals");
    expect(agentInvocationContext({ channelId: "telegram", id: "invocation-2" })).toBe("telegram");
  });

  it("rejects unsafe external links", () => {
    expect(
      agentInvocationExternalUrl({
        annotations: { "github.url": "javascript:alert(1)" },
        id: "invocation-3",
      }),
    ).toBeUndefined();
  });
});
