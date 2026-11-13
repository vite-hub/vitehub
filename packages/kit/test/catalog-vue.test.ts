import { JSONUIProvider, Renderer } from "@json-render/vue";
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";

import { type CatalogSpec, viteHubCatalog } from "@vite-hub/kit/catalog";
import { catalogComponents, defineCatalogRegistry } from "@vite-hub/kit/catalog/vue";

import { approvalForm } from "./catalog-fixtures.ts";

type Handlers = Record<string, (params: Record<string, unknown>) => unknown>;

async function render(spec: CatalogSpec, registry = defineCatalogRegistry(viteHubCatalog, catalogComponents), handlers: Handlers = {}): Promise<string> {
  const app = createSSRApp({
    render: () => h(JSONUIProvider, { registry, initialState: spec.state, handlers }, { default: () => h(Renderer, { spec, registry }) }),
  });
  return renderToString(app);
}

describe("@vite-hub/kit/catalog/vue", () => {
  it("has a default component for every built-in entry", () => {
    expect(Object.keys(catalogComponents).sort()).toEqual(Object.keys(viteHubCatalog.entries).sort());
  });

  it("renders a form spec on the server with the default components", async () => {
    const html = await render(approvalForm);
    expect(html).toContain("<form data-slot=\"form\"");
    expect(html).toContain("<h2 data-slot=\"heading\">Approve the api-search release?</h2>");
    // The state fills the bound inputs.
    expect(html).toMatch(/<option value="production"[^>]*selected[^>]*>Production<\/option>/);
    expect(html).toContain("Note for the release log");
    expect(html).toMatch(/<textarea[^>]*placeholder="Optional"/);
    expect(html).toContain("<dt>Commits</dt><dd>3 since v2.4.0</dd>");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Approve<\/button>/);
  });

  it("renders the parts that use headless components", async () => {
    const html = await render({
      root: "root",
      elements: {
        root: { type: "Stack", props: { direction: "horizontal" }, children: ["tabs", "agree", "beta", "plan", "line", "go"] },
        tabs: { type: "Tabs", props: { tabs: ["One", "Two"] }, children: ["one", "two"] },
        one: { type: "Text", props: { text: "First panel" } },
        two: { type: "Text", props: { text: "Second panel" } },
        agree: { type: "Checkbox", props: { label: "I agree", checked: { $bindState: "/agree" } } },
        beta: { type: "Switch", props: { label: "Beta", checked: { $bindState: "/beta" } } },
        plan: { type: "RadioGroup", props: { label: "Plan", value: { $bindState: "/plan" }, options: [{ label: "Free", value: "free" }] } },
        line: { type: "Divider", props: {} },
        go: { type: "Button", props: { label: "Deploy", variant: "primary" }, on: { press: { action: "deploy" } } },
      },
      state: { agree: true, beta: false, plan: "free" },
    });
    expect(html).toContain("flex-direction:row");
    expect(html).toContain("First panel");
    expect(html).toContain("role=\"tab\"");
    expect(html).toContain("role=\"checkbox\"");
    expect(html).toContain("aria-checked=\"true\"");
    expect(html).toContain("role=\"switch\"");
    expect(html).toContain("role=\"radiogroup\"");
    expect(html).toContain("role=\"separator\"");
    expect(html).toMatch(/<button[^>]*data-variant="primary"[^>]*>Deploy<\/button>/);
  });

  it("passes the app's components the element props, event listeners, and v-model listeners", async () => {
    const seen: Record<string, unknown>[] = [];
    const sent: Record<string, unknown>[] = [];
    const Probe = defineComponent({
      inheritAttrs: false,
      setup(_, { attrs }) {
        seen.push({ ...attrs });
        return () => h("span", "probe");
      },
    });
    const registry = defineCatalogRegistry(viteHubCatalog, { ...catalogComponents, Button: Probe, Input: Probe });
    await render({
      root: "root",
      elements: {
        root: { type: "Stack", props: {}, children: ["go", "email"] },
        go: { type: "Button", props: { label: "Go" }, on: { press: { action: "go", params: { email: { $state: "/email" } } } } },
        email: { type: "Input", props: { label: "Email", value: { $bindState: "/email" } } },
      },
      state: { email: "ada@example.com" },
    }, registry, { go: (params) => { sent.push(params); } });
    expect(seen).toEqual([
      { label: "Go", onPress: expect.any(Function) },
      { "label": "Email", "value": "ada@example.com", "onUpdate:value": expect.any(Function) },
    ]);

    // The input writes to its state path, and the press sends the action with the params read from state.
    const [button, input] = seen;
    const call = (value: unknown, ...args: unknown[]) => (typeof value === "function" ? value(...args) : undefined);
    call(input?.["onUpdate:value"], "grace@example.com");
    call(button?.onPress);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toEqual([{ email: "grace@example.com" }]);
  });
});
