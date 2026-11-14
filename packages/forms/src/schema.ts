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
