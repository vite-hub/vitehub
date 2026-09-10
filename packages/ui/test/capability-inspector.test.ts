// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { AgentCapabilityInspector, capabilityInspectionSpec } from "../src/components/agent-capability-inspector.ts";
import { mcp, title } from "@vite-hub/agent/capabilities";
import type { AgentInvocationView } from "../src/types.ts";

const invocation = (): AgentInvocationView => ({
  id: "first", traceId: "trace", createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:01Z", status: "completed", observations: [],
  configuration: {
    capabilities: [
      { id: "mcp", inspection: { ...mcp({ servers: {} }).inspection!, state: { servers: [{ name: "docs-server", status: "Resolved", tools: ["mcp_docs_read"] }, { name: "optional", status: "Skipped", tools: [] }] } } },
      { id: "custom-title", inspection: { ...title().inspection!, state: { status: "Generating", title: null, generation: "Custom execute", model: "model", maxLength: 39, timeoutMs: 20000, trigger: "Any", channelDelivery: "always" } } },
      { id: "plain", metadata: { mode: "read" } },
    ],
    tools: [{ capabilityId: "mcp", name: "mcp_docs_read", mcp: { server: "docs-server", name: "read-doc" }, description: "Read docs", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, outputSchema: { type: "string" } }],
  },
});

describe("Capability inspector", () => {
  it("renders the actual MCP contribution, server groups, provenance and complete schemas", () => {
    const wrapper = mount(AgentCapabilityInspector, { props: { invocation: invocation() } });
    expect(wrapper.findAll("section h3").map(heading => heading.text())).toEqual(["docs-server", "optional"]);
    expect(wrapper.text()).toContain("Skipped");
    expect(wrapper.text()).toContain("mcp_docs_read");
    expect(wrapper.text()).toContain("read-doc");
    expect(wrapper.text()).toContain("Input schema");
    expect(wrapper.text()).toContain("Output schema");
    expect(wrapper.text()).toContain("Required");
    wrapper.unmount();
  });

  it("updates Title state without losing selection and resets selection between Invocations", async () => {
    const current = invocation();
    const wrapper = mount(AgentCapabilityInspector, { props: { invocation: current } });
    await wrapper.findAll("nav button")[1]!.trigger("click");
    expect(wrapper.text()).toContain("Generating");
    const updated = invocation();
    updated.configuration!.capabilities![1]!.inspection!.state = { ...updated.configuration!.capabilities![1]!.inspection!.state, status: "Completed", title: "A useful title" };
    await wrapper.setProps({ invocation: updated });
    expect(wrapper.text()).toContain("A useful title");
    expect(wrapper.findAll("nav button")[1]!.attributes("aria-pressed")).toBe("true");
    await wrapper.setProps({ invocation: { ...invocation(), id: "second" } });
    expect(wrapper.findAll("nav button")[0]!.attributes("aria-pressed")).toBe("true");
    wrapper.unmount();
  });

  it("preserves generic, missing-content, unknown-view and truncated fallbacks", async () => {
    const current = invocation();
    const wrapper = mount(AgentCapabilityInspector, { props: { invocation: current } });
    await wrapper.findAll("nav button")[2]!.trigger("click");
    expect(wrapper.text()).toContain('"mode": "read"');
    await wrapper.setProps({ invocation: { ...current, id: "unknown", configuration: { truncated: true, capabilities: [{ id: "future", inspection: { label: "Future", state: { count: 2 }, view: { root: "custom", elements: { custom: { type: "FutureComponent", props: {} } } } } }] } } });
    expect(wrapper.text()).toContain("truncated");
    expect(wrapper.text()).toContain("This view is unavailable");
    expect(wrapper.text()).toContain('"count": 2');
    await wrapper.setProps({ invocation: { ...current, id: "omitted", configuration: { capabilities: [{ id: "mcp", inspection: { label: "MCP" } }] } } });
    expect(wrapper.text()).toContain("Inspection data was not recorded");
    await wrapper.setProps({ invocation: { ...current, id: "empty", configuration: {} } });
    expect(wrapper.text()).toContain("No capabilities recorded");
    wrapper.unmount();
  });

  it("does not show another server's tools when a captured tool filter is missing", () => {
    const current = invocation();
    current.configuration!.capabilities![0]!.inspection!.state = { servers: [{ name: "unknown", status: "Not discovered" }] };
    const wrapper = mount(AgentCapabilityInspector, { props: { invocation: current } });
    expect(wrapper.text()).toContain("No tool contracts recorded");
    expect(wrapper.text()).not.toContain("mcp_docs_read");
    wrapper.unmount();
  });

  it("rejects actions, computed expressions, cyclic trees and unsupported components", () => {
    const element = { type: "Text", props: { text: "Safe" } };
    expect(capabilityInspectionSpec({ root: "text", elements: { text: element } })).toBeDefined();
    for (const unsafe of [
      { ...element, on: { press: { action: "tools.call" } } },
      { ...element, props: { text: { $computed: "anything" } } },
      { ...element, children: ["text"] },
      { type: "Button", props: { text: "Run" } },
    ]) expect(capabilityInspectionSpec({ root: "text", elements: { text: unsafe } })).toBeUndefined();
  });
});
