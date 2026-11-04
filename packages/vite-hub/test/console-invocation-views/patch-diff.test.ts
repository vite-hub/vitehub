// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it, vi } from "vitest";
import { AgentInvocation } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import { invocationActivities } from "../../src/console/runtime/components/invocation/internal/invocation-activity.ts";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";

vi.mock("@vite-hub/ui/patch-diff", () => ({
  PatchDiff: defineComponent({
    props: { patch: { required: true, type: String } },
    setup: props => () => h("pre", { class: "patch-diff-stub" }, props.patch),
  }),
}));

describe("Agent Invocation file changes", () => {
  it("renders the lazy diff view when a file change opens", async () => {
    const timestamp = "2026-08-30T16:34:08.000Z";
    const invocation = {
      createdAt: timestamp,
      id: "file-change",
      observations: [{
        attributes: {
          "tool.id": "patch",
          "tool.name": "apply_patch",
          "tool.output": { item: { changes: [{ diff: "@@ -1 +1 @@\n-old\n+new\n", path: "/workspace/app/src/kv.ts" }], type: "fileChange" } },
          "vitehub.activity.title": "Changed 1 file",
        },
        name: "agent.tool.finish",
        sequence: 1,
        timestamp,
        type: "run",
      }],
      startedAt: timestamp,
      status: "running",
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { attachTo: document.body, props: { header: false, invocation } });

    const details = wrapper.get<HTMLDetailsElement>('[data-kind="change"] details.vh-invocation-event');
    details.element.open = true;
    await details.trigger("toggle");
    await flushPromises();
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(wrapper.find(".patch-diff-stub").text()).toContain("+new");
    wrapper.unmount();
  });

  it("gives each file of a turn diff its own patch", () => {
    const timestamp = "2026-08-22T00:00:00.000Z";
    const first = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+A\n";
    const second = "diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-b\n+B\n";
    const invocation = {
      createdAt: timestamp,
      id: "turn-diff",
      observations: [{
        attributes: { "vitehub.activity.body": `${first}${second}`, "vitehub.activity.kind": "change" },
        name: "agent.turn.diff.updated",
        sequence: 1,
        timestamp,
        type: "run",
      }],
      status: "completed",
      traceId: "trace",
      updatedAt: timestamp,
    } satisfies AgentInvocationView;

    expect(invocationActivities(invocation)[0]).toMatchObject({ patches: [first, second], paths: ["src/a.ts", "src/b.ts"] });
  });
});
