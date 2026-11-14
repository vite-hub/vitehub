// The C4 check for `@vite-hub/agent/ui`: diagnostics of validateSpec(), the surface subsets, a layout with a Form
// of @vite-hub/forms that checkForm() validates, and a server render with the default Vue components.
import { JSONUIProvider, Renderer } from "@json-render/vue"
import { checkForm } from "@vite-hub/forms"
import { describe, expect, it } from "vitest"
import { createSSRApp, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { z } from "zod"

import { catalogPrompt, type CatalogSpec, type CatalogSurface, catalogSurfaces, checkSpecForm, defineCatalog, portableEntries, specFormFields, surfaceEntries, validateSpec, viteHubCatalog, viteHubCatalogEntries } from "@vite-hub/agent/ui"
import { catalogComponents, defineCatalogRegistry } from "@vite-hub/agent/ui/vue"

const invite = z.object({
  email: z.email("Enter a valid email."),
  role: z.enum(["admin", "member", "viewer"]),
  seats: z.number().int().min(1, "Pick 1 to 10.").max(10, "Pick 1 to 10."),
})
// A choice of numbers draws on a web page and in a chat modal, but an MCP elicitation takes only choices of text.
const plan = z.object({ size: z.union([z.literal(1), z.literal(2)]) })
const nested = z.object({ address: z.object({ city: z.string() }) })
const catalog = defineCatalog(viteHubCatalogEntries, { forms: { invite, plan, nested } })

const event = (name: string, context?: Record<string, unknown>) => ({ action: "event", params: { name, ...(context ? { context } : {}) } })

/** An approval card with a job table, a list from state, tabs, and a Form of `invite`. */
const layout: CatalogSpec = {
  version: 1,
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["card", "tabs"] },
    card: { type: "Card", props: { title: "Deploy acme/web to production" }, children: ["author", "files", "jobs", "approve", "reject"] },
    author: { type: "KeyValue", props: { label: "Author", value: "Dana Reyes" } },
    files: { type: "KeyValue", props: { label: "Files changed", value: { $state: "/diff/files" } } },
    jobs: { type: "Table", props: { columns: [{ key: "job", label: "Job" }, { key: "state", label: "State" }], rows: [{ job: "build", state: "done" }, { job: "test", state: "failed" }] } },
    approve: { type: "Button", props: { label: "Approve", variant: "primary" }, on: { press: event("deploy.approve", { repo: "acme/web" }) } },
    reject: { type: "Button", props: { label: "Reject" }, on: { press: event("deploy.reject", { repo: "acme/web" }) } },
    tabs: { type: "Tabs", props: { tabs: ["Deployments", "Invite"] }, children: ["deployments", "form"] },
    deployments: { type: "Stack", props: {}, repeat: { statePath: "/deployments", key: "id" }, children: ["deployment"] },
    deployment: { type: "KeyValue", props: { label: { $item: "id" }, value: { $item: "state" } } },
    form: { type: "Form", props: { form: "invite", value: { $bindState: "/invite" }, submitLabel: "Send invite" }, on: { submit: event("invite.send", { values: { $state: "/invite" } }) } },
  },
  state: {
    diff: { files: 12 },
    deployments: [{ id: "dpl_81", state: "Ready" }, { id: "dpl_79", state: "Failed" }],
    invite: { role: "member", seats: 3 },
  },
}

const codes = (spec: unknown, surface: CatalogSurface = "web") => {
  const result = validateSpec(spec, { surface, catalog })
  return result.valid ? [] : result.diagnostics.map(entry => `${entry.code} ${entry.path}`)
}

const one = (elements: CatalogSpec["elements"], state?: Record<string, unknown>): CatalogSpec => ({ root: "root", elements, ...(state ? { state } : {}) })

describe("validateSpec", () => {
  it("accepts the layout with its Form on every surface that draws all of its parts", () => {
    expect(validateSpec(layout, { surface: "web", catalog })).toEqual({ valid: true, spec: layout, diagnostics: [] })
    expect(codes(layout, "mcp")).toEqual([])
  })

  it("returns plain JSON diagnostics with a code, a fix, a docs link, and a JSON Pointer", () => {
    const result = validateSpec(one({ root: { type: "Input", props: { label: "Email" } } }), { surface: "web", catalog })
    expect(result).toEqual({
      valid: false,
      diagnostics: [{
        code: "AGENT_UI_R0004",
        message: expect.stringContaining("The catalog has no component \"Input\""),
        fix: expect.stringContaining("use a Form that names a form of the catalog"),
        docs: "https://vitehub.dev/docs/agents/diagnostics/agent_ui_r0004",
        path: "/elements/root/type",
      }],
    })
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it.each<[string, unknown, string[]]>([
    ["a spec without elements", { root: "root" }, ["AGENT_UI_R0001 "]],
    ["an unknown element key", one({ root: { type: "Text", props: { text: "Hi" }, slots: {} } }), ["AGENT_UI_R0001 /elements/root/slots"]],
    ["another version", { version: 2, ...one({ root: { type: "Text", props: { text: "Hi" } } }) }, ["AGENT_UI_R0002 /version"]],
    ["a missing child", one({ root: { type: "Stack", props: {}, children: ["gone"] } }), ["AGENT_UI_R0003 /elements/root/children/0"]],
    ["an input component", one({ root: { type: "Checkbox", props: {} } }), ["AGENT_UI_R0004 /elements/root/type"]],
    ["an unknown prop", one({ root: { type: "Text", props: { text: "Hi", color: "red" } } }), ["AGENT_UI_R0006 /elements/root/props/color"]],
    ["an invalid prop", one({ root: { type: "Image", props: { src: "not a url", alt: "" } } }), ["AGENT_UI_R0007 /elements/root/props/src"]],
    ["a state read of the wrong type", one({ root: { type: "Text", props: { text: { $state: "/user" } } } }, { user: { name: "Ada" } }), ["AGENT_UI_R0007 /elements/root/props/text"]],
    ["a repeated item of the wrong type", one({
      root: { type: "Stack", props: {}, repeat: { statePath: "/rows" }, children: ["row"] },
      row: { type: "Text", props: { text: { $item: "name" } } },
    }, { rows: [{ name: "api" }, { name: ["web"] }] }), ["AGENT_UI_R0007 /elements/row/props/text"]],
    ["an event that the component does not emit", one({ root: { type: "Text", props: { text: "Hi" }, on: { press: event("x") } } }), ["AGENT_UI_R0008 /elements/root/on/press"]],
    ["children on a leaf", one({ root: { type: "Text", props: { text: "Hi" }, children: ["child"] }, child: { type: "Text", props: { text: "Hi" } } }), ["AGENT_UI_R0009 /elements/root/children"]],
    ["too many elements", one(Object.fromEntries(Array.from({ length: 129 }, (_, index) => [index ? `t${index}` : "root", { type: "Text", props: { text: "Hi" } }]))), ["AGENT_UI_R0010 /elements"]],
    ["a cycle", one({ root: { type: "Stack", props: {}, children: ["a"] }, a: { type: "Stack", props: {}, children: ["root"] } }), ["AGENT_UI_R0012 /elements/root"]],
    ["a child used twice", one({ root: { type: "Stack", props: {}, children: ["a", "a"] }, a: { type: "Text", props: { text: "Hi" } } }), ["AGENT_UI_R0013 /elements/a"]],
    ["an action that is not the event", one({ root: { type: "Button", props: { label: "Go" }, on: { press: { action: "approve" } } } }), ["AGENT_UI_R0014 /elements/root/on/press/action"]],
    ["an event without a name", one({ root: { type: "Button", props: { label: "Go" }, on: { press: { action: "event", params: {} } } } }), ["AGENT_UI_R0001 /elements/root/on/press/params"]],
    ["a form that the catalog does not have", one({ root: { type: "Form", props: { form: "signup" } } }), ["AGENT_UI_R0015 /elements/root/props/form"]],
    ["form values that are not a state binding", one({ root: { type: "Form", props: { form: "invite", value: { role: "member" } } } }), ["AGENT_UI_R0007 /elements/root/props/value"]],
    ["a form that no surface can draw", one({ root: { type: "Form", props: { form: "nested" } } }), ["AGENT_UI_R0016 /elements/root/props/form"]],
  ])("reports %s", (_, spec, expected) => {
    expect(codes(spec)).toEqual(expected)
  })

  it("reports a tree deeper than 20 levels once", () => {
    const elements: CatalogSpec["elements"] = {}
    for (let level = 0; level < 23; level++) elements[level ? `s${level}` : "root"] = { type: "Stack", props: {}, children: [`s${level + 1}`] }
    elements.s23 = { type: "Text", props: { text: "deep" } }
    expect(codes(one(elements))).toEqual(["AGENT_UI_R0011 /elements/s20"])
  })
})

describe("surface subsets", () => {
  it("holds layout and display parts only, and a Form that names a form of @vite-hub/forms", () => {
    expect(Object.fromEntries(catalogSurfaces.map(surface => [surface, surfaceEntries(viteHubCatalog, surface).map(entry => entry.name)]))).toEqual({
      web: ["Stack", "Text", "Heading", "KeyValue", "Divider", "Card", "Button", "Link", "Image", "Badge", "Table", "Tabs", "Form"],
      mcp: ["Stack", "Text", "Heading", "KeyValue", "Divider", "Card", "Button", "Link", "Image", "Badge", "Table", "Tabs", "Form"],
      chatCard: ["Stack", "Text", "Heading", "KeyValue", "Divider", "Card", "Button", "Link", "Image", "Table"],
      chatModal: ["Stack", "Text", "Heading", "KeyValue", "Form"],
    })
    expect(portableEntries(viteHubCatalog).map(entry => entry.name)).toEqual(["Stack", "Text", "Heading", "KeyValue"])
  })

  it("refuses the parts that a surface cannot draw", () => {
    // A chat card has no inputs and no tabs.
    expect(codes(layout, "chatCard")).toEqual(["AGENT_UI_R0005 /elements/tabs/type", "AGENT_UI_R0005 /elements/form/type"])
    // A chat modal holds a form, not buttons or tables.
    const modal = one({ root: { type: "Stack", props: {}, children: ["note", "form"] }, note: { type: "Text", props: { text: "Who joins?" } }, form: layout.elements.form! }, { invite: {} })
    expect(codes(modal, "chatModal")).toEqual([])
    expect(codes(layout, "chatModal")).toContain("AGENT_UI_R0005 /elements/approve/type")
  })

  it("checks a form with the surfaces of @vite-hub/forms", () => {
    const spec = one({ root: { type: "Form", props: { form: "plan", value: { $bindState: "/plan" } } } }, { plan: {} })
    expect(codes(spec, "web")).toEqual([])
    expect(codes(spec, "chatModal")).toEqual([])
    const result = validateSpec(spec, { surface: "mcp", catalog })
    expect(result.valid ? [] : result.diagnostics).toEqual([expect.objectContaining({ code: "AGENT_UI_R0016", message: expect.stringContaining("FORMS_C0002"), path: "/elements/root/props/form" })])
  })
})

describe("a Form in a layout", () => {
  it("draws the fields of its form, from formFields()", () => {
    expect(specFormFields(layout, "form", { catalog }).map(field => [field.name, field.type, field.options ?? field.format ?? null])).toEqual([
      ["email", "string", "email"],
      ["role", "string", ["admin", "member", "viewer"]],
      ["seats", "integer", null],
    ])
  })

  it("checks the sent values with checkForm(), with the same issues as the form schema", async () => {
    await expect(checkSpecForm(layout, "form", { email: "ada@example.com", role: "member", seats: 3 }, { catalog })).resolves.toEqual([undefined, { email: "ada@example.com", role: "member", seats: 3 }])
    const bad = { email: "ada", role: "member", seats: 30 }
    const [error] = await checkSpecForm(layout, "form", bad, { catalog })
    const [direct] = await checkForm(invite, bad)
    expect(error?.issues).toEqual(direct?.issues)
    expect(error?.issues.map(issue => [issue.path.join("."), issue.message])).toEqual([["email", "Enter a valid email."], ["seats", "Pick 1 to 10."]])
  })

  it("throws AGENT_UI_C0004 for an element that is not a Form", () => {
    expect(() => checkSpecForm(layout, "approve", {}, { catalog })).toThrow(expect.objectContaining({ code: "AGENT_UI_C0004" }))
  })
})

describe("the prompt", () => {
  it("is json-render's prompt for the surface, with the event action and the fields of each form", () => {
    const prompt = catalogPrompt({ surface: "chatCard", catalog })
    expect(prompt).toContain("JSONL")
    expect(prompt).toContain("\"action\": \"event\"")
    expect(prompt).toContain("- invite:\n  - email: string (email), required. Email")
    expect(prompt).toContain("  - role: one of \"admin\", \"member\", \"viewer\", required. Role")
    expect(prompt).toContain("A card has no inputs")
    expect(prompt).toMatch(/\bTable\b/)
    expect(prompt).not.toMatch(/\bTabs\b/)
  })
})

describe("@vite-hub/agent/ui/vue", () => {
  it("has a default component for every built-in entry", () => {
    expect(Object.keys(catalogComponents).sort()).toEqual(Object.keys(viteHubCatalog.entries).sort())
  })

  it("renders the layout on the server, with the form's fields filled from the state", async () => {
    const registry = defineCatalogRegistry(catalog, catalogComponents)
    const app = createSSRApp({ render: () => h(JSONUIProvider, { registry, initialState: layout.state, handlers: {} }, { default: () => h(Renderer, { spec: layout, registry }) }) })
    const html = await renderToString(app)
    expect(html).toContain("<h3>Deploy acme/web to production</h3>")
    expect(html).toContain("<dt>Files changed</dt><dd>12</dd>")
    expect(html).toContain("<td>test</td><td>failed</td>")
    expect(html).toContain("<dt>dpl_81</dt><dd>Ready</dd>")
    expect(html).toContain("<dt>dpl_79</dt><dd>Failed</dd>")
    expect(html).toContain("data-form=\"invite\"")
    expect(html).toMatch(/<label for="[^"]+">Email<\/label><input[^>]*name="email"[^>]*required[^>]*type="email"/)
    expect(html).toMatch(/<option value="member" selected>member<\/option>/)
    expect(html).toMatch(/<input[^>]*name="seats"[^>]*type="number"[^>]*value="3"[^>]*min="1"[^>]*max="10"/)
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Send invite<\/button>/)
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Approve<\/button>/)
    expect(html).toContain("Deployments")
  })
})
