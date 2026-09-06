// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/internal/pierre-code-view.ts", () => ({
  PierreCodeView: defineComponent({ render: () => h("div", "code view loaded") }),
  PierreDiff: defineComponent({
    props: { patch: String },
    render() {
      return h("div", { "data-pierre-diff": "" }, this.patch);
    },
  }),
  PierreFile: defineComponent({ render: () => h("div", "file loaded") }),
  PierreUnresolvedFile: defineComponent({ render: () => h("div", "unresolved file loaded") }),
}));

import { AgentPatchDiff } from "../src/components/agent-code-view.ts";

describe("lazy code views", () => {
  it("loads and renders the Pierre adapter on demand in the browser", async () => {
    const wrapper = mount(AgentPatchDiff, { props: { patch: "change.patch" } });

    await vi.waitFor(() => {
      expect(wrapper.get("[data-pierre-diff]").text()).toBe("change.patch");
    });
  });

  it("resolves the same adapter while rendering on the server", async () => {
    const app = createSSRApp({
      render: () => h(AgentPatchDiff, { patch: "server.patch" }),
    });

    const html = await renderToString(app);
    expect(html).toContain("server.patch");
    expect(html).toContain("data-pierre-diff");
  });
});
