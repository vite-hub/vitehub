import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { type A2uiMessage, a2uiBasicCatalogId, type CatalogSpec, fromA2ui, portableEntries, toA2ui, validateSpec, viteHubCatalog } from "@vite-hub/kit/catalog";

import { approvalForm } from "./catalog-fixtures.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Component = { id: string; component: string } & Record<string, Json>;

// The default values of the A2UI v1.0 basic catalog. A component that states one equals a component that leaves it out.
const a2uiDefaults: Record<string, Record<string, Json>> = {
  Text: { variant: "body" },
  TextField: { variant: "shortText" },
  Button: { variant: "default" },
  Divider: { axis: "horizontal" },
  ChoicePicker: { variant: "mutuallyExclusive" },
};

function isObject(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The component tree and data model of A2UI messages, with child ids replaced by the children and default values left out. */
function rendered(messages: readonly unknown[]): { tree: Json; dataModel: Json } {
  const components = new Map<string, Component>();
  let dataModel: Record<string, Json> = {};
  for (const message of messages) {
    if (!isObject(message)) continue;
    const { createSurface, updateComponents, updateDataModel } = message;
    for (const list of [isObject(createSurface) ? createSurface.components : undefined, isObject(updateComponents) ? updateComponents.components : undefined]) {
      if (Array.isArray(list)) for (const component of list) if (isObject(component)) components.set(String(component.id), component as Component);
    }
    if (isObject(createSurface) && isObject(createSurface.dataModel)) dataModel = { ...dataModel, ...createSurface.dataModel };
    if (isObject(updateDataModel) && isObject(updateDataModel.value)) dataModel = { ...dataModel, ...updateDataModel.value };
  }
  const resolve = (id: Json): Json => {
    const { id: _, ...component } = components.get(String(id)) ?? { id: "", component: "Missing" };
    const defaults = a2uiDefaults[component.component] ?? {};
    const out: Record<string, Json> = {};
    for (const [key, value] of Object.entries(component)) {
      if (defaults[key] === value) continue;
      if (key === "children" && Array.isArray(value)) out[key] = value.map(resolve);
      else if (key === "child") out[key] = resolve(value);
      else if (key === "tabs" && Array.isArray(value)) out[key] = value.map(tab => (isObject(tab) ? { ...tab, child: resolve(tab.child ?? "") } : tab));
      else out[key] = value;
    }
    return out;
  };
  return { tree: resolve("root"), dataModel };
}

function convert(spec: CatalogSpec): A2uiMessage[] {
  const result = toA2ui(spec, { surfaceId: "test" });
  if (!result.ok) throw new TypeError(JSON.stringify(result.diagnostics));
  return result.messages;
}

function back(messages: readonly unknown[]): CatalogSpec {
  const result = fromA2ui(messages);
  if (!result.ok) throw new TypeError(JSON.stringify(result.diagnostics));
  return result.spec;
}

/** One spec with every entry of the portable subset, in each form its props take. */
const portable: CatalogSpec = {
  version: 1,
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["title", "intro", "muted", "hash", "status", "live", "row"] },
    title: { type: "Heading", props: { text: "Deploy api-search" } },
    intro: { type: "Text", props: { text: "Three commits since v2.4.0." } },
    muted: { type: "Text", props: { text: { $state: "/summary" }, tone: "muted" } },
    hash: { type: "Text", props: { text: "## not a heading" } },
    status: { type: "KeyValue", props: { label: "Status", value: "Ready" } },
    live: { type: "KeyValue", props: { label: "Region", value: { $state: "/region" } } },
    row: { type: "Stack", props: { direction: "horizontal", align: "center", justify: "spaceBetween" }, children: ["small"] },
    small: { type: "Heading", props: { text: "Checks", level: 4 } },
  },
  state: { summary: "All checks passed.", region: "eu-west" },
};

describe("A2UI v1.0", () => {
  it("round-trips every entry of the portable subset", () => {
    const used = new Set(Object.values(portable.elements).map(element => element.type));
    expect([...used].sort()).toEqual(portableEntries(viteHubCatalog).map(entry => entry.name).sort());
    for (const surface of ["web", "mcp", "chatCard", "chatModal"] as const) expect(validateSpec(portable, { surface }).valid).toBe(true);

    const messages = convert(portable);
    expect(messages[0]).toEqual({ version: "1.0", createSurface: { surfaceId: "test", catalogId: a2uiBasicCatalogId, sendDataModel: true, dataModel: portable.state } });
    expect(messages[1]).toMatchObject({ version: "1.0", updateComponents: { surfaceId: "test" } });
    expect(messages[1] && "updateComponents" in messages[1] ? messages[1].updateComponents.components : []).toEqual([
      { id: "root", component: "Column", children: ["title", "intro", "muted", "hash", "status", "live", "row"] },
      { id: "title", component: "Text", text: "## Deploy api-search" },
      { id: "intro", component: "Text", text: "Three commits since v2.4.0." },
      { id: "muted", component: "Text", text: { "@path": "/summary" }, variant: "caption" },
      { id: "hash", component: "Text", text: "\\## not a heading" },
      { id: "status", component: "Column", children: ["status.label", "status.value"] },
      { id: "status.label", component: "Text", text: "Status", variant: "caption" },
      { id: "status.value", component: "Text", text: "Ready" },
      { id: "live", component: "Column", children: ["live.label", "live.value"] },
      { id: "live.label", component: "Text", text: "Region", variant: "caption" },
      { id: "live.value", component: "Text", text: { "@path": "/region" } },
      { id: "row", component: "Row", children: ["small"], align: "center", justify: "spaceBetween" },
      { id: "small", component: "Text", text: "#### Checks" },
    ]);
    expect(back(messages)).toEqual(portable);
  });

  it("round-trips the components outside the portable subset that A2UI has", () => {
    const spec: CatalogSpec = {
      version: 1,
      root: "root",
      elements: {
        root: { type: "Card", props: { title: "Rename project", description: "The name shows in links." }, children: ["tabs", "line", "image", "docs", "save"] },
        tabs: { type: "Tabs", props: { tabs: ["Name", "Options"] }, children: ["name", "options"] },
        name: { type: "Stack", props: {}, children: ["field", "about", "secret", "count"] },
        field: { type: "Input", props: { label: "Name", value: { $bindState: "/name" }, placeholder: "acme-docs" } },
        about: { type: "Textarea", props: { label: "About", value: { $bindState: "/about" } } },
        secret: { type: "Input", props: { label: "Token", value: { $bindState: "/token" }, type: "password" } },
        count: { type: "Input", props: { label: "Seats", value: { $bindState: "/seats" }, type: "number" } },
        options: { type: "Stack", props: {}, children: ["region", "plan", "public"] },
        region: { type: "Select", props: { label: "Region", value: { $bindState: "/region" }, options: [{ label: "EU", value: "eu" }] } },
        plan: { type: "RadioGroup", props: { label: "Plan", value: { $bindState: "/plan" }, options: [{ label: "Free", value: "free" }, { label: "Pro", value: "pro" }] } },
        public: { type: "Checkbox", props: { label: "Public", checked: { $bindState: "/public" } } },
        line: { type: "Divider", props: {} },
        image: { type: "Image", props: { src: "https://vitehub.dev/logo.png", alt: "ViteHub logo" } },
        docs: { type: "Link", props: { text: "Read the docs", href: "https://vitehub.dev/docs" } },
        save: { type: "Button", props: { label: "Save", variant: "primary" }, on: { press: { action: "rename", params: { name: { $state: "/name" }, source: "dialog" } } } },
      },
      state: { name: "acme-docs", about: "", token: "", seats: "3", region: "eu", plan: "free", public: false },
    };
    expect(validateSpec(spec, { surface: "web" }).valid).toBe(true);
    expect(back(convert(spec))).toEqual(spec);
  });

  it("converts Form, Switch, and the email type one way", () => {
    const spec: CatalogSpec = {
      version: 1,
      root: "root",
      elements: {
        root: { type: "Form", props: { submitLabel: "Send" }, children: ["email", "news"], on: { submit: { action: "subscribe", params: { email: { $state: "/email" } } } } },
        email: { type: "Input", props: { label: "Email", value: { $bindState: "/email" }, type: "email" } },
        news: { type: "Switch", props: { label: "Weekly news", checked: { $bindState: "/news" } } },
      },
    };
    expect(back(convert(spec))).toEqual({
      version: 1,
      root: "root",
      elements: {
        "root": { type: "Stack", props: {}, children: ["email", "news", "root.submit"] },
        "email": { type: "Input", props: { label: "Email", value: { $bindState: "/email" } } },
        "news": { type: "Checkbox", props: { label: "Weekly news", checked: { $bindState: "/news" } } },
        "root.submit": { type: "Button", props: { label: "Send", variant: "primary" }, on: { press: { action: "subscribe", params: { email: { $state: "/email" } } } } },
      },
    });
  });

  it("names what does not convert to A2UI", () => {
    const spec: CatalogSpec = { root: "root", elements: { root: { type: "Stack", props: {}, children: ["table", "go"] }, table: { type: "Table", props: { columns: [{ key: "a", label: "A" }], rows: [] } }, go: { type: "Button", props: { label: "Go" } } } };
    const result = toA2ui(spec, { surfaceId: "test" });
    expect(result.ok ? [] : result.diagnostics.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "KIT_R0013", path: "/elements/table" },
      { code: "KIT_R0013", path: "/elements/go" },
    ]);
    expect(toA2ui(approvalForm, { surfaceId: "test" }).ok).toBe(true);
  });

  // The samples of the A2UI basic catalog that use only mapped features, copied from a2ui-project/a2ui at 58379ad
  // (catalogs/basic/v1/examples, Apache-2.0).
  const samples = new URL("./fixtures/a2ui/", import.meta.url);
  for (const file of readdirSync(samples)) {
    it(`reads the A2UI sample ${file} and writes the same UI back`, () => {
      const { messages }: { messages: unknown[] } = JSON.parse(readFileSync(new URL(file, samples), "utf8"));
      const spec = back(messages);
      expect(validateSpec(spec, { surface: "web" })).toMatchObject({ valid: true });
      expect(rendered(convert(spec))).toEqual(rendered(messages));
    });
  }

  it("names A2UI features that the catalog cannot express", () => {
    const result = fromA2ui([
      { version: "1.0", createSurface: { surfaceId: "s", catalogId: a2uiBasicCatalogId } },
      { version: "1.0", updateComponents: { surfaceId: "s", components: [
        { id: "root", component: "Column", children: ["icon", "when"] },
        { id: "icon", component: "Icon", name: "mail" },
        { id: "when", component: "Text", text: { "@call": "formatDate", args: { value: "2026-01-01" } } },
      ] } },
    ]);
    expect(result.ok ? [] : result.diagnostics.map(({ code, message }) => ({ code, message }))).toEqual([
      { code: "KIT_R0014", message: "The A2UI messages cannot convert to a spec: Icon property \"name\" has no ViteHub mapping." },
      { code: "KIT_R0014", message: "The A2UI messages cannot convert to a spec: Icon has no ViteHub mapping." },
      { code: "KIT_R0014", message: "The A2UI messages cannot convert to a spec: only literals and absolute {\"@path\"} bindings convert. Function calls do not." },
    ]);
    expect(fromA2ui([{ version: "0.9", createSurface: { surfaceId: "s", catalogId: a2uiBasicCatalogId } }]).ok).toBe(false);
  });
});
