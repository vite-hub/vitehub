// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import { AgentInvocationInspector } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";

function invocation(metadata: unknown): AgentInvocationView {
  return {
    id: "invocation-boundary", traceId: "trace", createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:01Z",
    status: "completed", observations: [],
    configuration: { capabilities: [{ id: "custom", metadata: metadata as never }] },
  };
}

const cyclic: Record<string, unknown> = { count: 1 };
cyclic.self = cyclic;

const cases = [
  ["cyclic", cyclic, '"self": "[Circular]"'],
  ["BigInt", { count: 1n }, '"count": "1n"'],
  ["throwing toJSON", { toJSON() { throw new Error("cannot serialize metadata"); } }, "[Unable to display payload: cannot serialize metadata]"],
] as const;

describe("AgentInvocationInspector capability metadata serialization", () => {
  it.each(cases)("renders %s without crashing", async (_name, metadata, expected) => {
    const props = { invocation: invocation(metadata), showCapabilities: true };
    const wrapper = mount(AgentInvocationInspector, { props });
    expect(wrapper.find(".vh-invocation-inspector__settings pre").text()).toContain(expected);
    wrapper.unmount();
    const html = await renderToString(createSSRApp({ render: () => h(AgentInvocationInspector, props) }));
    expect(html.replaceAll("&quot;", "\"")).toContain(expected);
  });
});
