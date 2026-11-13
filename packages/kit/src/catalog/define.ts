import { duplicateEntry, invalidEntry } from "./diagnostics.ts";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "./standard-schema.ts";

/**
 * Where a spec renders:
 * - `web`: a Vue or Nuxt page;
 * - `mcp`: an MCP App in a host such as Claude, ChatGPT, or VS Code;
 * - `chatCard`: a card that a chat bot posts in Slack, Teams, Discord, or Telegram, which has no inputs;
 * - `chatModal`: a chat modal, such as a Slack modal or a Teams dialog, which holds a form.
 */
export type CatalogSurface = "web" | "mcp" | "chatCard" | "chatModal";

/** Every surface, in a stable order. */
export const catalogSurfaces: readonly CatalogSurface[] = ["web", "mcp", "chatCard", "chatModal"];

/** The props schema of an entry: an object schema of any library that implements Standard Schema and Standard JSON Schema, such as Zod 4. */
export interface CatalogPropsSchema {
  readonly "~standard": StandardSchemaV1.Props & Pick<StandardJSONSchemaV1.Props, "jsonSchema">;
}

/** One component that an Agent may use in a spec. */
export interface CatalogEntry<Name extends string = string> {
  /** The PascalCase component name that a spec element puts in `type`. */
  readonly name: Name;
  /** What the component is and when to use it. It goes into the model prompt as written, so keep it short. */
  readonly description: string;
  /** The props of a spec element of this type. */
  readonly props: CatalogPropsSchema;
  /** The events that a spec element can bind in `on`, each with the moment it fires. */
  readonly events: Readonly<Record<string, string>>;
  /** Whether a spec element of this type can have `children`. */
  readonly children: boolean;
  /** The version of this entry. Raise it when a change of the props or events can break a saved spec. */
  readonly version: number;
  /** The surfaces where this component renders. */
  readonly surfaces: readonly CatalogSurface[];
}

/** The components that an Agent may use, by name. */
export interface Catalog<Name extends string = string> {
  readonly entries: Readonly<Record<Name, CatalogEntry<Name>>>;
}

const propsSchemas = new WeakMap<CatalogEntry, PropsJsonSchema>();

/** The JSON Schema of an entry's props, with the names of its props. */
export interface PropsJsonSchema {
  schema: Record<string, unknown>;
  names: string[];
}

/** The JSON Schema (draft 2020-12) of the props of `entry`. */
export function propsJsonSchema(entry: CatalogEntry): PropsJsonSchema {
  let cached = propsSchemas.get(entry);
  if (!cached) {
    const { $schema: _, ...schema } = entry.props["~standard"].jsonSchema.input({ target: "draft-2020-12" });
    const properties = schema.properties;
    if (schema.type !== "object" || !isRecord(properties)) throw invalidEntry(entry.name, "its props schema is not an object schema.");
    cached = { schema, names: Object.keys(properties) };
    propsSchemas.set(entry, cached);
  }
  return cached;
}

const componentName = /^[A-Z][A-Za-z0-9]*$/;
const eventName = /^[a-z][A-Za-z0-9]*$/;

function checkEntry(entry: CatalogEntry): void {
  const name = typeof entry.name === "string" ? entry.name : String(entry.name);
  if (!componentName.test(name)) throw invalidEntry(name, "its name is not PascalCase.");
  if (typeof entry.description !== "string" || !entry.description.trim()) throw invalidEntry(name, "it has no description.");
  const standard = entry.props?.["~standard"];
  if (typeof standard?.validate !== "function" || typeof standard.jsonSchema?.input !== "function") {
    throw invalidEntry(name, "its props schema does not implement Standard Schema and Standard JSON Schema.");
  }
  for (const event of Object.keys(entry.events)) if (!eventName.test(event)) throw invalidEntry(name, `its event "${event}" is not camelCase.`);
  if (!Number.isInteger(entry.version) || entry.version < 1) throw invalidEntry(name, "its version is not a positive integer.");
  if (!entry.surfaces.length || entry.surfaces.some(surface => !catalogSurfaces.includes(surface))) {
    throw invalidEntry(name, `its surfaces must be a non-empty list out of ${catalogSurfaces.join(", ")}.`);
  }
  propsJsonSchema(entry);
}

/**
 * Checks one catalog entry and returns it as it is. It throws `KIT_C0001` when the entry is invalid.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 *
 * export const rating = defineCatalogEntry({
 *   name: "Rating",
 *   description: "Stars from 1 to 5 that the user picks.",
 *   props: z.strictObject({ label: z.string(), value: z.strictObject({ $bindState: z.string() }) }),
 *   events: {},
 *   children: false,
 *   version: 1,
 *   surfaces: ["web", "mcp"],
 * });
 * ```
 */
export function defineCatalogEntry<const Name extends string>(entry: CatalogEntry<Name>): CatalogEntry<Name> {
  checkEntry(entry);
  return entry;
}

/**
 * Builds a catalog from its entries. It throws `KIT_C0001` for an invalid entry and `KIT_C0002` when two entries have the
 * same name.
 *
 * @example
 * ```ts
 * const catalog = defineCatalog([...viteHubCatalogEntries, rating]);
 * ```
 */
export function defineCatalog<const Entries extends readonly CatalogEntry[]>(entries: Entries): Catalog<Entries[number]["name"]> {
  const byName: Record<string, CatalogEntry> = {};
  for (const entry of entries) {
    checkEntry(entry);
    if (Object.hasOwn(byName, entry.name)) throw duplicateEntry(entry.name);
    byName[entry.name] = entry;
  }
  // SAFETY: `byName` holds exactly the entries of `entries`, keyed by their names.
  return { entries: byName as Record<Entries[number]["name"], CatalogEntry<Entries[number]["name"]>> };
}

/** The entries of `catalog` that render on `surface`, in catalog order. */
export function surfaceEntries(catalog: Catalog, surface: CatalogSurface): CatalogEntry[] {
  return Object.values<CatalogEntry>(catalog.entries).filter(entry => entry.surfaces.includes(surface));
}

/** The entries of `catalog` that render on every surface. A spec of only these renders anywhere and converts to A2UI. */
export function portableEntries(catalog: Catalog): CatalogEntry[] {
  return Object.values<CatalogEntry>(catalog.entries).filter(entry => catalogSurfaces.every(surface => entry.surfaces.includes(surface)));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
