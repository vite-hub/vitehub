import type { StandardSchemaV1 } from "@standard-schema/spec"

/** The parts of a Valibot schema used by native forms and `AutoForm`. */
export interface SchemaNode {
  type: string
  wrapped?: SchemaNode
  pipe?: readonly SchemaNode[]
  entries?: Record<string, SchemaNode>
  options?: readonly unknown[]
  requirement?: unknown
  title?: string
  description?: string
}

/** The base schema, whether a wrapper made it optional, and the actions of every layer, outer first. */
export function unwrap(node: SchemaNode): { node: SchemaNode, required: boolean, actions: readonly SchemaNode[] } {
  let current = node
  let required = true
  const actions: SchemaNode[] = [...node.pipe ?? []]
  while (["optional", "nullish", "nullable", "exact_optional", "undefinedable"].includes(current.type) && current.wrapped) {
    required = false
    current = current.wrapped
    actions.push(...current.pipe ?? [])
  }
  return { node: current, required, actions }
}

/** Decode HTML controls to schema input types. Validation still checks every decoded value. */
export function coerceFormFields(schema: StandardSchemaV1, fields: Record<string, unknown>): void {
  if (schema["~standard"].vendor !== "valibot") return
  // SAFETY: the vendor identifies Valibot; only the object shape supported by AutoForm is read.
  const root = schema as unknown as SchemaNode
  if (root.type !== "object" || !root.entries) return
  for (const [key, entry] of Object.entries(root.entries)) {
    const { node } = unwrap(entry)
    const value = fields[key]
    if (node.type === "boolean") {
      // Native checkboxes send "on" when checked and no field when unchecked.
      if (value === undefined) fields[key] = false
      else if (value === "on") fields[key] = true
    }
    else if (node.type === "number" && typeof value === "string") {
      // Omit empty controls so optional schema output stays JSON data.
      if (value === "") delete fields[key]
      else fields[key] = Number(value)
    }
    else if ((node.type === "picklist" || node.type === "enum") && typeof value === "string") {
      const option = node.options?.find(option => (typeof option === "string" || typeof option === "number") && String(option) === value)
      // Omit an empty placeholder. Keep valid empty choices and invalid values for validation.
      if (option === undefined && value === "") delete fields[key]
      else fields[key] = option ?? value
    }
  }
}
