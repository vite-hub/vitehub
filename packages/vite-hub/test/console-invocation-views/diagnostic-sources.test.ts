// @vitest-environment happy-dom

import { normalizeRuntimeDiagnosticError } from "@vite-hub/runtime";
import { mount } from "@vue/test-utils";
import { Diagnostic } from "nostics";
import { h } from "vue";
import { describe, expect, it } from "vitest";
import { AgentInvocation, AgentInvocationInspector } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";

function invocation(error: unknown): AgentInvocationView {
  return {
    createdAt: "2026-09-10T00:00:00Z",
    error: normalizeRuntimeDiagnosticError(error),
    id: "diagnostic-sources",
    observations: [],
    status: "failed",
    traceId: "trace",
    updatedAt: "2026-09-10T00:00:01Z",
  };
}

const sources = ["server/tools/search.ts:18:5", "server/agents/support.ts:9:3"];
const message = "Search index is missing.";

describe.each([
  { name: "Invocation", render: (value: AgentInvocationView) => h(AgentInvocation, { invocation: value }) },
  { name: "Inspector", render: (value: AgentInvocationView) => h(AgentInvocationInspector, { invocation: value }) },
])("$name diagnostic sources", ({ render }) => {
  it("renders normalized source locations with the existing diagnostic fields", () => {
    const diagnostic = new Diagnostic({
      code: "SEARCH_INDEX_MISSING",
      why: message,
      fix: "Create the search index before searching.",
      docs: "https://vitehub.dev/docs/reference/errors-diagnostics#agent-diagnostics",
      sources,
    });
    const wrapper = mount(() => render(invocation(diagnostic)));
    try {
      expect(JSON.parse(wrapper.get(".vh-invocation-error__details pre").text())).toEqual({
        code: diagnostic.code,
        docs: diagnostic.docs,
        fix: diagnostic.fix,
        message,
        sources,
      });
    } finally {
      wrapper.unmount();
    }
  });

  it("shows a diagnostic disclosure when source locations are the only details", () => {
    const wrapper = mount(() => render(invocation(Object.assign(new Error(message), { sources }))));
    try {
      const details = wrapper.get("details.vh-invocation-error__details");
      expect(details.get("summary").text()).toBe("Diagnostic details");
      expect(JSON.parse(details.get("pre").text())).toEqual({ message, sources });
    } finally {
      wrapper.unmount();
    }
  });

  it.each([undefined, []])("does not add a disclosure for sources %j", (value) => {
    const wrapper = mount(() => render(invocation(Object.assign(new Error(message), { sources: value }))));
    try {
      expect(wrapper.get(".vh-invocation-error__message").text()).toBe(message);
      expect(wrapper.find(".vh-invocation-error__details").exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});
