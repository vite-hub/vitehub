// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { AgentInvocation } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";

describe("Agent Invocation channel replies", () => {
  it("puts the channel icon in the same icon slot as other run steps", () => {
    const timestamp = "2026-08-30T16:41:02.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "reply",
      observations: [
        { attributes: { "input.prompt": "Fix it." }, name: "agent.invocation.start", sequence: 1, timestamp, type: "lifecycle" },
        { attributes: { "channel.delivery.provider": "github", "channel.effect.kind": "reply" }, name: "agent.channel.delivery", sequence: 2, timestamp, type: "run" },
      ],
      startedAt: timestamp,
      status: "running",
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { header: false, invocation } });

    const summary = wrapper.get('[data-kind="delivery"] .vh-invocation-event__summary');
    expect(summary.element.tagName).toBe("DIV");
    expect(summary.find('.vh-invocation-event__icon[data-icon="channel"] .vh-channel-icon').exists()).toBe(true);
  });
});
