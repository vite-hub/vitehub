import { type Catalog, type CatalogSurface, isRecord, propsJsonSchema, surfaceEntries } from "./define.ts";
import { viteHubCatalog } from "./entries.ts";
import { maxSpecDepth, maxSpecElements, specVersion } from "./validate.ts";

export interface CatalogPromptOptions {
  /** The surface where the spec renders. The prompt lists only the components of this surface. */
  surface: CatalogSurface;
  /** The built-in catalog by default. */
  catalog?: Catalog;
}

const surfaceNotes: Record<CatalogSurface, string> = {
  web: "The spec renders in a web page.",
  mcp: "The spec renders in an MCP App inside the user's AI client.",
  chatCard: "The spec renders as a card in a chat message. A card has no inputs: to ask for values, send a form for a chat modal.",
  chatModal: "The spec renders as a chat modal, such as a Slack modal. Make the root a Form.",
};

function wrap(type: string): string {
  return type.includes(" | ") ? `(${type})` : type;
}

/** A short TypeScript-like type for one JSON Schema. */
function typeOf(schema: unknown): string {
  if (!isRecord(schema)) return "unknown";
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(value => JSON.stringify(value)).join(" | ");
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) return union.map(typeOf).join(" | ");
  if (Array.isArray(schema.type)) return schema.type.map(type => typeOf({ type })).join(" | ");
  if (schema.type === "array") return `${wrap(typeOf(schema.items))}[]`;
  if (schema.type === "object") {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const keys = Object.keys(properties);
    if (!keys.length) return isRecord(schema.additionalProperties) ? `Record<string, ${typeOf(schema.additionalProperties)}>` : "{}";
    const required = Array.isArray(schema.required) ? schema.required : [];
    return `{ ${keys.map(key => `${JSON.stringify(key)}${required.includes(key) ? "" : "?"}: ${typeOf(properties[key])}`).join(", ")} }`;
  }
  if (schema.type === "integer") return "number";
  if (typeof schema.type === "string") return schema.type;
  return "unknown";
}

function constraints(schema: Record<string, unknown>): string {
  const notes: string[] = [];
  if (schema.format === "uri") notes.push("a URL");
  if (typeof schema.minItems === "number") notes.push(`at least ${schema.minItems}`);
  if (typeof schema.minLength === "number" && schema.minLength > 0) notes.push("not empty");
  return notes.length ? ` (${notes.join(", ")})` : "";
}

/**
 * The part of a system prompt that teaches a model to write specs for one surface: the spec format, the rules, and each
 * component with its props and events.
 *
 * @example
 * ```ts
 * const system = `${instructions}\n\n${catalogPrompt({ surface: "web" })}`;
 * ```
 */
export function catalogPrompt(options: CatalogPromptOptions): string {
  const catalog = options.catalog ?? viteHubCatalog;
  const lines = [
    "# UI",
    "",
    `You can answer with UI. Write it as a JSON spec. ${surfaceNotes[options.surface]}`,
    "",
    "```json",
    `{ "version": ${specVersion}, "root": "root", "elements": { "root": { "type": "Stack", "props": {}, "children": ["title"] }, "title": { "type": "Text", "props": { "text": "Hello" } } }, "state": {} }`,
    "```",
    "",
    "Rules:",
    "- `elements` maps an id to an element. `root` is the id of the top element. Call it \"root\".",
    "- An element has `type` (a component below) and `props`. Only components that take children have `children`: a list of ids, in order.",
    "- Use each id once in `children`. The elements form a tree.",
    "- Bind an input to a state path with `{ \"$bindState\": \"/path\" }`. Put its first value in `state`, such as `\"state\": { \"path\": \"\" }`.",
    "- Read a state path in a prop with `{ \"$state\": \"/path\" }` where the prop allows it.",
    "- An event sends an action: `\"on\": { \"press\": { \"action\": \"approve\", \"params\": { \"note\": { \"$state\": \"/note\" } } } }`.",
    `- Use at most ${maxSpecElements} elements and ${maxSpecDepth} levels.`,
    "- Use only the components and props below.",
    "",
    "Components:",
  ];
  for (const entry of surfaceEntries(catalog, options.surface)) {
    const { schema } = propsJsonSchema(entry);
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    lines.push("", `## ${entry.name}`, entry.description);
    const props = Object.entries(properties).map(([name, prop]) => {
      const details = isRecord(prop) ? constraints(prop) : "";
      return `- ${name}${required.includes(name) ? "" : "?"}: ${typeOf(prop)}${details}`;
    });
    lines.push(props.length ? "Props:" : "Props: none", ...props);
    const events = Object.entries(entry.events);
    if (events.length) lines.push("Events:", ...events.map(([name, when]) => `- ${name}: ${when}`));
    lines.push(entry.children ? "Takes children." : "Takes no children.");
  }
  return lines.join("\n");
}
