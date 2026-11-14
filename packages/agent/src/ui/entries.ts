import { z } from "zod"

import { type Catalog, type CatalogEntry, type CatalogSurface, defineCatalog, defineCatalogEntry } from "./define.ts"

/** Props hold the values that the spec's expressions resolve to, such as `{ "$state": "/total" }` or `{ "$item": "name" }`. */
const shown = z.union([z.string(), z.number()])

const all: CatalogSurface[] = ["web", "mcp", "chatCard", "chatModal"]
const card: CatalogSurface[] = ["web", "mcp", "chatCard"]
const page: CatalogSurface[] = ["web", "mcp"]
const form: CatalogSurface[] = ["web", "mcp", "chatModal"]

/** The names of the built-in entries. */
export type ViteHubComponent
  = | "Stack" | "Text" | "Heading" | "KeyValue" | "Divider" | "Card" | "Button" | "Link" | "Image" | "Badge" | "Table"
    | "Tabs" | "Form"

/** The built-in entries, in prompt order: layout and display components, and a Form that draws a form of `@vite-hub/forms`. */
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
    props: z.strictObject({ text: shown, tone: z.enum(["default", "muted"]).optional() }),
    events: {},
    children: false,
    version: 1,
    surfaces: all,
  }),
  defineCatalogEntry({
    name: "Heading",
    description: "The title of a section. Level 1 is the largest.",
    props: z.strictObject({ text: shown, level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional() }),
    events: {},
    children: false,
    version: 1,
    surfaces: all,
  }),
  defineCatalogEntry({
    name: "KeyValue",
    description: "A label with one value, such as Status: Deployed.",
    props: z.strictObject({ label: z.string(), value: shown }),
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
    description: "A button. Bind on.press to the event action, which tells the Agent what the person chose.",
    props: z.strictObject({ label: z.string().min(1), variant: z.enum(["primary", "secondary", "ghost"]).optional() }),
    events: { press: "The person pressed the button." },
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
    props: z.strictObject({ text: shown, tone: z.enum(["neutral", "success", "warning", "danger"]).optional() }),
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
    name: "Tabs",
    description: "Panels that share one place. Child n is the panel of tab n, so give one child for each tab.",
    props: z.strictObject({ tabs: z.array(z.string().min(1)).min(1) }),
    events: {},
    children: true,
    version: 1,
    surfaces: page,
  }),
  defineCatalogEntry({
    name: "Form",
    description: "Asks the person for values with a form of the app, named in form. The app's form schema gives the fields. Bind value to a state path with { \"$bindState\": \"/path\" }, and send the values in on.submit with { \"$state\": \"/path\" }.",
    props: z.strictObject({
      form: z.string().min(1),
      value: z.record(z.string(), z.unknown()).optional(),
      submitLabel: z.string().min(1).optional(),
    }),
    events: { submit: "The person sent the form." },
    children: false,
    version: 1,
    surfaces: form,
  }),
]

/** The built-in catalog, with no forms. `validateSpec()` and `catalogPrompt()` use it when you pass no catalog. */
export const viteHubCatalog: Catalog<ViteHubComponent> = defineCatalog(viteHubCatalogEntries)
