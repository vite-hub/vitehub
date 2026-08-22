// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { AgentInvocationList } from "../src/components/agent-invocation-list.ts";
import { AgentInvocation, AgentInvocationInspector } from "../src/components/agent-invocation.ts";

import type { AgentInvocationView } from "../src/types.ts";

describe("Agent Invocation UI", () => {
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

  it("keeps virtual rows in list coordinates when a header precedes them", async () => {
    const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() { return this.classList.contains("vh-invocation-list__virtual") ? 1000 : 0; },
    });
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `inv-${index}`,
      status: "completed" as const,
      title: `Invocation ${index}`,
    }));
    const wrapper = mount(AgentInvocationList, {
      props: { items },
      slots: { header: "Header" },
    });
    const viewport = wrapper.get("nav");
    Object.defineProperty(viewport.element, "clientHeight", { configurable: true, value: 430 });
    Object.defineProperty(viewport.element, "scrollTop", { configurable: true, value: 1860 });

    await viewport.trigger("scroll");

    expect(wrapper.get("li").attributes("data-index")).toBe("4");
    wrapper.unmount();
    if (offsetTop) Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTop);
  });

  it("uses one flexible grid row when the host owns the header", () => {
    const invocation: AgentInvocationView = {
      createdAt: "2026-08-22T00:00:00.000Z",
      id: "invocation",
      observations: [],
      status: "running",
      traceId: "trace",
      updatedAt: "2026-08-22T00:00:01.000Z",
    };
    const wrapper = mount(AgentInvocation, { props: { header: false, invocation } });

    expect(wrapper.get("article").classes()).toContain("vh-invocation-session--headerless");
  });
});
