// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentInvocation } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import { invocationActivities, invocationActivityTitle } from "../../src/console/runtime/components/invocation/internal/invocation-activity.ts";
import { event, invocation, message, notices, openDetails, openWork } from "./fixtures.ts";
import { loadMarkdown } from "./markdown.ts";

beforeAll(loadMarkdown);

const prepared = (name: string, bytes: number, origin: string, messageId: string) => ({ bytes, mediaType: "image/png", messageId, name, origin, path: `/workspace/t3-provider-runtime-a/userdata/attachments/${name}` });

const attachments = event("agent.input.attachments", {
  "input.attachments.prepared": [prepared("board.png", 1_100_000, "history", "m-1"), prepared("chart.png", 600_000, "history", "m-2"), prepared("current.png", 502_000, "current", "m-4")],
  "input.attachments.preparedBytes": 2_202_000,
  "input.attachments.preparedCount": 3,
  "input.attachments.skipped": [{ mediaType: "image/png", messageId: "m-3", name: "large.png", origin: "history", reason: "byte-budget" }],
  "input.attachments.skippedCount": 1,
  "vitehub.action.name": "input.attachments",
  "vitehub.activity.kind": "action",
});

describe("Agent Invocation input attachments", () => {
  it("shows which images the Driver prepared and why the others were left out in one row", async () => {
    const value = invocation([message("user", "What does the screenshot show?"), attachments, message("assistant", "A red marker.")]);
    const activity = invocationActivities(value).find(item => item.name === "agent.input.attachments");
    expect(activity && invocationActivityTitle(activity)).toBe("Prepared 3 images (2.1 MB), skipped 1: byte-budget");

    const wrapper = mount(AgentInvocation, { props: { invocation: value } });
    await openWork(wrapper);
    const row = wrapper.get('[data-kind="action"]');
    expect(row.get(".vh-invocation-event__title").text()).toBe("Prepared 3 images (2.1 MB), skipped 1: byte-budget");
    await openDetails(row.get("details"));
    // Ignore the Markdown code marks around names, ids and paths.
    const body = row.get(".vh-invocation-event__body").text().replaceAll("`", "");
    expect(body).toContain("Prepared: board.png · image/png · 1 MB · from history · message m-1");
    expect(body).toContain("/workspace/t3-provider-runtime-a/userdata/attachments/current.png");
    expect(body).toContain("Skipped (byte-budget): large.png · image/png · from history · message m-3");
  });

  it("counts every left-out image when the Driver prepared none", () => {
    const value = invocation([event("agent.input.attachments", {
      "input.attachments.prepared": [],
      "input.attachments.preparedBytes": 0,
      "input.attachments.preparedCount": 0,
      "input.attachments.skipped": [
        { mediaType: "image/png", origin: "history", reason: "max-images" },
        { mediaType: "image/png", origin: "history", reason: "max-images" },
        { mediaType: "image/png", origin: "history", reason: "fetch-failed:403" },
      ],
      "input.attachments.skippedCount": 3,
      "vitehub.activity.kind": "action",
    })]);
    expect(invocationActivityTitle(invocationActivities(value)[0]!)).toBe("Prepared no images, skipped 3: max-images (2), fetch-failed:403");
  });

  it("names shortened lists and does not summarize partial skip reasons", async () => {
    const value = invocation([message("user", "Which photos are available?"), event("agent.input.attachments", {
      "input.attachments.prepared": [],
      "input.attachments.preparedCount": 0,
      "input.attachments.skipped": Array.from({ length: 32 }, () => ({ mediaType: "image/png", origin: "history", reason: "max-images" })),
      "input.attachments.skippedCount": 33,
      "vitehub.activity.kind": "action",
      "vitehub.observation.truncated": true,
      "vitehub.observation.truncatedAttributes": ["input.attachments.skipped"],
    }), message("assistant", "No photos.")]);
    const activity = invocationActivities(value).find(item => item.name === "agent.input.attachments");
    expect(activity && invocationActivityTitle(activity)).toBe("Prepared no images, skipped 33");
    const wrapper = mount(AgentInvocation, { props: { invocation: value } });
    await openWork(wrapper);
    const row = wrapper.get('[data-kind="action"]');
    await openDetails(row.get("details"));
    expect(notices(row)).toEqual(["Skipped attachments shortened when recorded."]);
  });
});
