import { type Catalog, type CatalogSurface, propsJsonSchema, surfaceEntries } from "./define.ts";
import { viteHubCatalog } from "./entries.ts";
import { maxSpecElements, specVersion } from "./validate.ts";

export interface CatalogJsonSchemaOptions {
  /** The surface where the spec renders. The schema allows only the components of this surface. */
  surface: CatalogSurface;
  /** The built-in catalog by default. */
  catalog?: Catalog;
}

const actionBinding = {
  type: "object",
  properties: { action: { type: "string", minLength: 1 }, params: { type: "object" } },
  required: ["action"],
  additionalProperties: false,
};

/**
 * The JSON Schema (draft 2020-12) of a spec for one surface, for structured output and for tools that check specs.
 * `validateSpec()` also checks the parts that JSON Schema cannot express: references between elements, cycles, and
 * depth.
 */
export function catalogJsonSchema(options: CatalogJsonSchemaOptions): Record<string, unknown> {
  const catalog = options.catalog ?? viteHubCatalog;
  const entries = surfaceEntries(catalog, options.surface);
  const defs: Record<string, unknown> = { actionBinding };
  for (const entry of entries) {
    const events = Object.keys(entry.events);
    defs[entry.name] = {
      type: "object",
      description: entry.description,
      properties: {
        type: { const: entry.name },
        props: propsJsonSchema(entry).schema,
        ...(entry.children ? { children: { type: "array", items: { type: "string" } } } : {}),
        ...(events.length
          ? {
              on: {
                type: "object",
                properties: Object.fromEntries(events.map(event => [event, {
                  description: entry.events[event],
                  anyOf: [{ $ref: "#/$defs/actionBinding" }, { type: "array", items: { $ref: "#/$defs/actionBinding" }, minItems: 1 }],
                }])),
                additionalProperties: false,
              },
            }
          : {}),
      },
      required: ["type", "props"],
      additionalProperties: false,
    };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `ViteHub UI spec (${options.surface})`,
    type: "object",
    properties: {
      version: { const: specVersion },
      root: { type: "string" },
      elements: {
        type: "object",
        maxProperties: maxSpecElements,
        additionalProperties: { anyOf: entries.map(entry => ({ $ref: `#/$defs/${entry.name}` })) },
      },
      state: { type: "object" },
    },
    required: ["root", "elements"],
    additionalProperties: false,
    $defs: defs,
  };
}
