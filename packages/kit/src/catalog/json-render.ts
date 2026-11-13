import { type Catalog as JsonRenderCatalog, defineCatalog as defineJsonRenderCatalog } from "@json-render/core";
import { schema } from "@json-render/vue/schema";
import { z } from "zod";

import { type Catalog, type CatalogEntry, type CatalogPropsSchema, type CatalogSurface, propsJsonSchema, surfaceEntries } from "./define.ts";
import { viteHubCatalog } from "./entries.ts";

export interface JsonRenderCatalogOptions {
  /** Keep only the components of this surface. Every component by default. */
  surface?: CatalogSurface;
  /** The built-in catalog by default. */
  catalog?: Catalog;
}

function isZodSchema(props: CatalogPropsSchema): props is CatalogPropsSchema & z.ZodType {
  return props["~standard"].vendor === "zod" && props instanceof z.ZodType;
}

/** json-render reads Zod schemas. A props schema of another library goes through its JSON Schema. */
function zodProps(entry: CatalogEntry): z.ZodType {
  return isZodSchema(entry.props) ? entry.props : z.fromJSONSchema(propsJsonSchema(entry).schema);
}

/**
 * The catalog as a json-render catalog for `@json-render/vue`, for `defineRegistry()`, `catalog.prompt()`, and
 * `catalog.validate()` of json-render.
 */
export function toJsonRenderCatalog(options: JsonRenderCatalogOptions = {}): JsonRenderCatalog {
  const catalog = options.catalog ?? viteHubCatalog;
  const entries = options.surface ? surfaceEntries(catalog, options.surface) : Object.values<CatalogEntry>(catalog.entries);
  return defineJsonRenderCatalog(schema, {
    components: Object.fromEntries(entries.map(entry => [entry.name, {
      props: zodProps(entry),
      slots: entry.children ? ["default"] : [],
      description: entry.description,
    }])),
    actions: {},
  });
}
