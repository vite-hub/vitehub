import { z } from "zod";

import { type Catalog, type CatalogEntry, type CatalogSurface, defineCatalog, defineCatalogEntry } from "./define.ts";

/** A JSON Pointer into the spec's `state`, such as `/contact/email`. */
const statePath = z.string().regex(/^(?:\/(?:[^~/]|~[01])*)+$/, "Use a JSON Pointer such as \"/contact/email\".");

/** A two-way binding: the input shows the value at the path and writes the user's changes back to it. */
const bindState = z.strictObject({ $bindState: statePath }).describe("Two-way binding to a state path.");

/** A literal, or a read of a state path. */
function readState<Schema extends z.ZodType>(schema: Schema) {
  return z.union([schema, z.strictObject({ $state: statePath })]);
}

const options = z.array(z.strictObject({ label: z.string().min(1), value: z.string() })).min(1);

const all: CatalogSurface[] = ["web", "mcp", "chatCard", "chatModal"];
const card: CatalogSurface[] = ["web", "mcp", "chatCard"];
const modal: CatalogSurface[] = ["web", "mcp", "chatModal"];
const page: CatalogSurface[] = ["web", "mcp"];

/** The names of the built-in entries. */
export type ViteHubComponent
  = | "Stack" | "Text" | "Heading" | "KeyValue" | "Divider" | "Card" | "Button" | "Link" | "Image" | "Badge" | "Table"
    | "Form" | "Field" | "Input" | "Textarea" | "Select" | "RadioGroup" | "Checkbox" | "Switch" | "Tabs" | "Dialog";

/** The built-in entries, in prompt order. */
export const viteHubCatalogEntries: readonly CatalogEntry<ViteHubComponent>[] = [
  defineCatalogEntry({
    name: "Stack",
    description: "Lays out its children in a column, or in a row with direction \"horizontal\". Chat surfaces show a row as a column, except a row of Buttons.",
    props: z.strictObject({
      direction: z.enum(["vertical", "horizontal"]).optional(),
      align: z.enum(["start", "center", "end", "stretch"]).optional(),
      justify: z.enum(["start", "center", "end", "spaceBetween"]).optional(),
    }),
    events: {},
    children: true,
    version: 1,
    surfaces: all,
  }),
  defineCatalogEntry({
    name: "Text",
    description: "A paragraph of plain text.",
    props: z.strictObject({ text: readState(z.string()), tone: z.enum(["default", "muted"]).optional() }),
    events: {},
    children: false,
    version: 1,
    surfaces: all,
  }),
  defineCatalogEntry({
    name: "Heading",
    description: "The title of a section. Level 1 is the largest.",
    props: z.strictObject({ text: z.string().min(1), level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional() }),
    events: {},
    children: false,
    version: 1,
    surfaces: all,
  }),
  defineCatalogEntry({
    name: "KeyValue",
    description: "A label with one value, such as Status: Deployed.",
    props: z.strictObject({ label: readState(z.string()), value: readState(z.string()) }),
    events: {},
    children: false,
    version: 1,
    surfaces: all,
  }),
  defineCatalogEntry({
    name: "Divider",
    description: "A line between two groups of content.",
    props: z.strictObject({}),
    events: {},
    children: false,
    version: 1,
    surfaces: card,
  }),
  defineCatalogEntry({
    name: "Card",
    description: "A box that groups related content, with an optional title.",
    props: z.strictObject({ title: z.string().optional(), description: z.string().optional() }),
    events: {},
    children: true,
    version: 1,
    surfaces: card,
  }),
  defineCatalogEntry({
    name: "Button",
    description: "A button that sends an action. Bind the action in on.press.",
    props: z.strictObject({ label: z.string().min(1), variant: z.enum(["primary", "secondary", "ghost"]).optional() }),
    events: { press: "The user pressed the button." },
    children: false,
    version: 1,
    surfaces: card,
  }),
  defineCatalogEntry({
    name: "Link",
    description: "Text that opens a URL.",
    props: z.strictObject({ text: z.string().min(1), href: z.url() }),
    events: {},
    children: false,
    version: 1,
    surfaces: card,
  }),
  defineCatalogEntry({
    name: "Image",
    description: "An image from a URL. Describe it in alt.",
    props: z.strictObject({ src: z.url(), alt: z.string() }),
    events: {},
    children: false,
    version: 1,
    surfaces: card,
  }),
  defineCatalogEntry({
    name: "Badge",
    description: "A short status label, such as Live or Failed.",
    props: z.strictObject({ text: readState(z.string()), tone: z.enum(["neutral", "success", "warning", "danger"]).optional() }),
    events: {},
    children: false,
    version: 1,
    surfaces: page,
  }),
  defineCatalogEntry({
    name: "Table",
    description: "Rows of data under named columns. Each row maps a column key to its value.",
    props: z.strictObject({
      columns: z.array(z.strictObject({ key: z.string().min(1), label: z.string() })).min(1),
      rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
      caption: z.string().optional(),
    }),
    events: {},
    children: false,
    version: 1,
    surfaces: card,
  }),
  defineCatalogEntry({
    name: "Form",
    description: "Holds inputs and a submit button with submitLabel. Bind the submit action in on.submit, and pass the values with {\"$state\": \"/path\"} params.",
    props: z.strictObject({ submitLabel: z.string().min(1) }),
    events: { submit: "The user submitted the form." },
    children: true,
    version: 1,
    surfaces: modal,
  }),
  defineCatalogEntry({
    name: "Field",
    description: "A label and help text for a group of controls, such as several Checkboxes.",
    props: z.strictObject({ label: z.string().min(1), description: z.string().optional() }),
    events: {},
    children: true,
    version: 1,
    surfaces: page,
  }),
  defineCatalogEntry({
    name: "Input",
    description: "One line of text from the user. Bind value to a state path.",
    props: z.strictObject({
      label: z.string().min(1),
      value: bindState,
      placeholder: z.string().optional(),
      type: z.enum(["text", "email", "number", "password", "url"]).optional(),
    }),
    events: {},
    children: false,
    version: 1,
    surfaces: modal,
  }),
  defineCatalogEntry({
    name: "Textarea",
    description: "Several lines of text from the user. Bind value to a state path.",
    props: z.strictObject({ label: z.string().min(1), value: bindState, placeholder: z.string().optional() }),
    events: {},
    children: false,
    version: 1,
    surfaces: modal,
  }),
  defineCatalogEntry({
    name: "Select",
    description: "One choice from a list that opens on demand. Bind value to a state path.",
    props: z.strictObject({ label: z.string().min(1), value: bindState, options, placeholder: z.string().optional() }),
    events: {},
    children: false,
    version: 1,
    surfaces: modal,
  }),
  defineCatalogEntry({
    name: "RadioGroup",
    description: "One choice from a short list with every option in view. Bind value to a state path.",
    props: z.strictObject({ label: z.string().min(1), value: bindState, options }),
    events: {},
    children: false,
    version: 1,
    surfaces: modal,
  }),
  defineCatalogEntry({
    name: "Checkbox",
    description: "A yes or no answer, such as accepting terms. Bind checked to a state path.",
    props: z.strictObject({ label: z.string().min(1), checked: bindState }),
    events: {},
    children: false,
    version: 1,
    surfaces: page,
  }),
  defineCatalogEntry({
    name: "Switch",
    description: "A setting that turns on or off. Bind checked to a state path.",
    props: z.strictObject({ label: z.string().min(1), checked: bindState }),
    events: {},
    children: false,
    version: 1,
    surfaces: page,
  }),
  defineCatalogEntry({
    name: "Tabs",
    description: "Panels that share one place. Child n is the panel of tab n, so give one child for each tab.",
    props: z.strictObject({ tabs: z.array(z.string().min(1)).min(1) }),
    events: {},
    children: true,
    version: 1,
    surfaces: page,
  }),
  defineCatalogEntry({
    name: "Dialog",
    description: "A window over the page for one decision or a short form. A button with triggerLabel opens it, and its children are its content.",
    props: z.strictObject({ title: z.string().min(1), description: z.string().optional(), triggerLabel: z.string().min(1) }),
    events: {},
    children: true,
    version: 1,
    surfaces: page,
  }),
];

/** The built-in catalog. `validateSpec()`, `catalogPrompt()`, and `catalogJsonSchema()` use it when you pass no catalog. */
export const viteHubCatalog: Catalog<ViteHubComponent> = defineCatalog(viteHubCatalogEntries);
