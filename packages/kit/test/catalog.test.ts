import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type CatalogDiagnosticCode,
  type CatalogPropsSchema,
  catalogJsonSchema,
  catalogPrompt,
  catalogSurfaces,
  defineCatalog,
  defineCatalogEntry,
  portableEntries,
  toJsonRenderCatalog,
  validateSpec,
  viteHubCatalog,
  viteHubCatalogEntries,
} from "@vite-hub/kit/catalog";

import { approvalForm } from "./catalog-fixtures.ts";

function codes(spec: unknown, surface: (typeof catalogSurfaces)[number] = "web"): CatalogDiagnosticCode[] {
  const result = validateSpec(spec, { surface });
  return result.valid ? [] : result.diagnostics.map(diagnostic => diagnostic.code);
}

function thrownCode(define: () => unknown): string | undefined {
  try {
    define();
  }
  catch (error) {
    return error instanceof Error ? error.name : undefined;
  }
  return undefined;
}

function withElement(element: Record<string, unknown>): Record<string, unknown> {
  return { root: "root", elements: { root: { type: "Stack", props: {}, children: ["it"] }, it: element } };
}

describe("@vite-hub/kit/catalog", () => {
  it("lists the built-in entries with the surfaces where each renders", () => {
    expect(Object.fromEntries(viteHubCatalogEntries.map(entry => [entry.name, entry.surfaces.join(" ")]))).toMatchInlineSnapshot(`
      {
        "Badge": "web mcp",
        "Button": "web mcp chatCard",
        "Card": "web mcp chatCard",
        "Checkbox": "web mcp",
        "Dialog": "web mcp",
        "Divider": "web mcp chatCard",
        "Field": "web mcp",
        "Form": "web mcp chatModal",
        "Heading": "web mcp chatCard chatModal",
        "Image": "web mcp chatCard",
        "Input": "web mcp chatModal",
        "KeyValue": "web mcp chatCard chatModal",
        "Link": "web mcp chatCard",
        "RadioGroup": "web mcp chatModal",
        "Select": "web mcp chatModal",
        "Stack": "web mcp chatCard chatModal",
        "Switch": "web mcp",
        "Table": "web mcp chatCard",
        "Tabs": "web mcp",
        "Text": "web mcp chatCard chatModal",
        "Textarea": "web mcp chatModal",
      }
    `);
    expect(portableEntries(viteHubCatalog).map(entry => entry.name)).toEqual(["Stack", "Text", "Heading", "KeyValue"]);
    // A posted chat card has no inputs.
    for (const name of ["Input", "Textarea", "Select", "RadioGroup", "Checkbox", "Switch", "Form"]) {
      expect(viteHubCatalog.entries[name as keyof typeof viteHubCatalog.entries].surfaces).not.toContain("chatCard");
    }
  });

  it("writes the model prompt for a surface", () => {
    const prompt = catalogPrompt({ surface: "chatModal" });
    expect(prompt).toMatchSnapshot();
    expect(prompt).not.toContain("## Button");
    expect(catalogPrompt({ surface: "chatCard" })).not.toContain("## Input");
    expect(catalogPrompt({ surface: "web" })).toContain("## Dialog");
  });

  it("writes the JSON Schema of a spec for a surface", () => {
    const schema = catalogJsonSchema({ surface: "chatCard" });
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      required: ["root", "elements"],
      properties: { version: { const: 1 }, elements: { maxProperties: 128 } },
    });
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    expect(Object.keys(defs).sort()).toEqual(["Button", "Card", "Divider", "Heading", "Image", "KeyValue", "Link", "Stack", "Table", "Text", "actionBinding"]);
    expect(defs.Button).toEqual({
      type: "object",
      description: "A button that sends an action. Bind the action in on.press.",
      properties: {
        type: { const: "Button" },
        props: {
          type: "object",
          properties: { label: { type: "string", minLength: 1 }, variant: { type: "string", enum: ["primary", "secondary", "ghost"] } },
          required: ["label"],
          additionalProperties: false,
        },
        on: {
          type: "object",
          properties: { press: { description: "The user pressed the button.", anyOf: [{ $ref: "#/$defs/actionBinding" }, { type: "array", items: { $ref: "#/$defs/actionBinding" }, minItems: 1 }] } },
          additionalProperties: false,
        },
      },
      required: ["type", "props"],
      additionalProperties: false,
    });
    expect(defs.Text?.properties).not.toHaveProperty("children");
  });

  it("passes a good form spec", () => {
    for (const surface of ["web", "mcp", "chatModal"] as const) expect(validateSpec(approvalForm, { surface })).toEqual({ valid: true, spec: approvalForm, diagnostics: [] });
  });

  it("rejects an Input in a chat card with KIT_R0005", () => {
    const spec = withElement({ type: "Input", props: { label: "Name", value: { $bindState: "/name" } } });
    expect(codes(spec, "web")).toEqual([]);
    const result = validateSpec(spec, { surface: "chatCard" });
    expect(result).toEqual({
      valid: false,
      diagnostics: [{
        code: "KIT_R0005",
        message: "Input does not render on the chatCard surface. Use one of: Stack, Text, Heading, KeyValue, Divider, Card, Button, Link, Image, Table.",
        fix: expect.stringContaining("A posted chat card (chatCard) has no inputs"),
        docs: "https://vitehub.dev/docs/ui/diagnostics/kit_r0005",
        path: "/elements/it/type",
      }],
    });
    expect(codes(approvalForm, "chatCard")).toEqual(["KIT_R0005", "KIT_R0005", "KIT_R0005"]);
  });

  it("gives each diagnostic code for its bad input", () => {
    const cases: [CatalogDiagnosticCode, unknown, ((typeof catalogSurfaces)[number])?][] = [
      ["KIT_R0001", { root: "root" }],
      ["KIT_R0001", { root: "root", elements: { root: { type: "Text", props: { text: "a" }, visible: true } } }],
      ["KIT_R0001", withElement({ type: "Button", props: { label: "Go" }, on: { press: { name: "go" } } })],
      ["KIT_R0002", { version: 2, root: "root", elements: { root: { type: "Divider", props: {} } } }],
      ["KIT_R0003", { root: "missing", elements: { root: { type: "Divider", props: {} } } }],
      ["KIT_R0003", { root: "root", elements: { root: { type: "Stack", props: {}, children: ["ghost"] } } }],
      ["KIT_R0004", withElement({ type: "Carousel", props: {} })],
      ["KIT_R0005", withElement({ type: "Dialog", props: { title: "Rename", triggerLabel: "Rename" } }), "chatModal"],
      ["KIT_R0006", withElement({ type: "Text", props: { text: "Hi", color: "red" } })],
      ["KIT_R0007", withElement({ type: "Heading", props: { text: "Hi", level: 7 } })],
      ["KIT_R0007", withElement({ type: "Input", props: { label: "Email", value: "x@y.z" } })],
      ["KIT_R0008", withElement({ type: "Button", props: { label: "Go" }, on: { hover: { action: "go" } } })],
      ["KIT_R0009", { root: "root", elements: { root: { type: "Text", props: { text: "a" }, children: ["b"] }, b: { type: "Divider", props: {} } } }],
      ["KIT_R0010", { root: "e0", elements: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`e${index}`, { type: "Divider", props: {} }])) }],
      ["KIT_R0011", { root: "e0", elements: Object.fromEntries(Array.from({ length: 23 }, (_, index) => [`e${index}`, { type: "Stack", props: {}, children: index < 22 ? [`e${index + 1}`] : [] }])) }],
      ["KIT_R0012", { root: "a", elements: { a: { type: "Stack", props: {}, children: ["b"] }, b: { type: "Stack", props: {}, children: ["a"] } } }],
    ];
    for (const [code, spec, surface] of cases) expect(codes(spec, surface), code).toEqual([code]);
  });

  it("points each diagnostic at the failing part of the spec", () => {
    const result = validateSpec(withElement({ type: "Input", props: { label: "", value: { $bindState: "email" } } }), { surface: "web" });
    expect(result.valid ? [] : result.diagnostics.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "KIT_R0007", path: "/elements/it/props/label" },
      { code: "KIT_R0007", path: "/elements/it/props/value/$bindState" },
    ]);
  });

  it("checks custom entries of any Standard Schema library", () => {
    // A Standard Schema without Zod: it validates by hand and states its JSON Schema.
    const ratingProps: CatalogPropsSchema = {
      "~standard": {
        version: 1,
        vendor: "hand-written",
        validate: value => typeof value === "object" && value !== null && "stars" in value && typeof value.stars === "number" && value.stars >= 1 && value.stars <= 5
          ? { value }
          : { issues: [{ message: "stars must be a number from 1 to 5.", path: ["stars"] }] },
        jsonSchema: {
          input: () => ({ type: "object", properties: { stars: { type: "integer", minimum: 1, maximum: 5 } }, required: ["stars"], additionalProperties: false }),
          output: () => ({ type: "object" }),
        },
      },
    };
    const rating = defineCatalogEntry({ name: "Rating", description: "Stars from 1 to 5.", props: ratingProps, events: {}, children: false, version: 1, surfaces: ["web", "mcp"] });
    const catalog = defineCatalog([...viteHubCatalogEntries, rating]);
    expect(validateSpec(withElement({ type: "Rating", props: { stars: 4 } }), { surface: "web", catalog }).valid).toBe(true);
    const bad = validateSpec(withElement({ type: "Rating", props: { stars: 9 } }), { surface: "web", catalog });
    expect(bad.valid ? [] : bad.diagnostics.map(({ code, message }) => ({ code, message }))).toEqual([
      { code: "KIT_R0007", message: "Rating prop \"stars\" is invalid: stars must be a number from 1 to 5." },
    ]);
    expect(catalogPrompt({ surface: "web", catalog })).toContain("## Rating\nStars from 1 to 5.\nProps:\n- stars: number\nTakes no children.");
    expect(toJsonRenderCatalog({ catalog }).validate({ root: "r", elements: { r: { type: "Rating", props: { stars: 3 }, children: [] } } }).success).toBe(true);
  });

  it("throws a configuration diagnostic for a bad entry or catalog", () => {
    const entry = { name: "Chart", description: "A chart.", props: z.strictObject({}), events: {}, children: false, version: 1, surfaces: ["web"] as const };
    expect(thrownCode(() => defineCatalogEntry({ ...entry, name: "chart" }))).toBe("KIT_C0001");
    expect(thrownCode(() => defineCatalogEntry({ ...entry, version: 0 }))).toBe("KIT_C0001");
    expect(thrownCode(() => defineCatalogEntry({ ...entry, events: { "on-click": "Never." } }))).toBe("KIT_C0001");
    expect(thrownCode(() => defineCatalogEntry({ ...entry, props: z.string() }))).toBe("KIT_C0001");
    expect(thrownCode(() => defineCatalog([...viteHubCatalogEntries, defineCatalogEntry({ ...entry, name: "Text" })]))).toBe("KIT_C0002");
    expect(thrownCode(() => validateSpec(withElement({ type: "Slow", props: {} }), { surface: "web", catalog: defineCatalog([defineCatalogEntry({ ...entry, name: "Stack", children: true }), defineCatalogEntry({ ...entry, name: "Slow", props: z.strictObject({}).refine(async () => true) })]) }))).toBe("KIT_C0003");
  });

  it("builds a json-render catalog that validates and prompts like the ViteHub catalog", () => {
    const catalog = toJsonRenderCatalog({ surface: "chatModal" });
    expect(catalog.componentNames).toEqual(["Stack", "Text", "Heading", "KeyValue", "Form", "Input", "Textarea", "Select", "RadioGroup"]);
    const spec = { ...approvalForm, elements: Object.fromEntries(Object.entries(approvalForm.elements).map(([id, element]) => [id, { children: [], ...element }])) };
    expect(catalog.validate(spec).success).toBe(true);
    expect(catalog.prompt()).toContain("Holds inputs and a submit button with submitLabel.");
  });
});
