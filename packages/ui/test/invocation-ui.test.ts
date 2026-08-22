// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { AgentInvocationList } from "../src/components/agent-invocation-list.ts";
import { AgentInvocationInspector } from "../src/components/agent-invocation.ts";

import type { AgentInvocationView } from "../src/types.ts";

describe("Agent Invocation UI", () => {
  it("discloses truncated invocation configuration", () => {
    const invocation: AgentInvocationView = {
      configuration: { instructions: ["partial"], truncated: true },
      createdAt: "2026-08-22T00:00:00.000Z",
      id: "invocation",
      observations: [],
      status: "completed",
      traceId: "trace",
      updatedAt: "2026-08-22T00:00:01.000Z",
    };
    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });

    expect(wrapper.text()).toContain("Some configuration values were truncated");
  });

  it("copies identifiers without displaying their full values", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const invocation: AgentInvocationView = {
      createdAt: "2026-08-22T00:00:00.000Z",
      id: "sha256_invocation_identifier",
      observations: [],
      status: "completed",
      traceId: "sha256_trace_identifier",
      updatedAt: "2026-08-22T00:00:01.000Z",
    };
    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });

    expect(wrapper.text()).not.toContain(invocation.id);
    expect(wrapper.text()).not.toContain(invocation.traceId);
    await wrapper.get('button[aria-label="Copy Trace ID"]').trigger("click");
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(invocation.traceId);
    expect(wrapper.get('button[aria-label="Copy Trace ID"]').text()).toContain("Copied");
    wrapper.unmount();
  });

  it("lets a user retry lazy loading by scrolling again after a failed page", async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      id: `inv-${index}`,
      status: "completed" as const,
      title: `Invocation ${index}`,
    }));
    const wrapper = mount(AgentInvocationList, {
      props: { hasMore: true, items },
    });
    const viewport = wrapper.get("nav");
    Object.defineProperty(viewport.element, "scrollTop", {
      configurable: true,
      writable: true,
      value: 20 * 86,
    });

    await viewport.trigger("scroll");
    expect(wrapper.emitted("endReached")).toHaveLength(1);

    await wrapper.setProps({ loading: true });
    await wrapper.setProps({ loading: false });
    await viewport.trigger("scroll");
    expect(wrapper.emitted("endReached")).toHaveLength(2);
  });
});
