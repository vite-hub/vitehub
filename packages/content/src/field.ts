/** The attribute that names the Content field an element renders. */
export const contentFieldAttribute = "data-content-field"

/** One field of one document: `posts:hello#title`, or `settings#title` for a singleton. */
export interface ContentFieldAddress {
  collection: string
  /** The document id. Undefined for a singleton. */
  id?: string
  /** Dot path into the document fields, such as `hero.title` or `cards.0.title`. */
  field: string
}

const collectionName = /^[A-Za-z_$][\w$-]*$/
const fieldPath = /^[\w$-]+(?:\.[\w$-]+)*$/

/**
 * Attributes that mark an element as the rendering of one Content field, so tools on the page, such as ViteHub
 * Comments, can find the document and field behind it. Spread them on the element that shows the value:
 * `<h1 v-bind="contentField('about', 'hero.title')">`. Pass the id for a document of a `documents()` collection.
 */
export function contentField(collection: string, field: string): Record<typeof contentFieldAttribute, string>
export function contentField(collection: string, id: string, field: string): Record<typeof contentFieldAttribute, string>
export function contentField(collection: string, idOrField: string, field?: string): Record<typeof contentFieldAttribute, string> {
  const address: ContentFieldAddress = field === undefined ? { collection, field: idOrField } : { collection, id: idOrField, field }
  return { [contentFieldAttribute]: formatContentField(address) }
}

/** Writes a field address as `collection[:id]#field`. Throws for a name or path that the format cannot hold. */
export function formatContentField(address: ContentFieldAddress): string {
  if (!collectionName.test(address.collection)) throw new TypeError(`[vitehub] ${JSON.stringify(address.collection)} is not a Content collection name.`)
  if (!fieldPath.test(address.field)) throw new TypeError(`[vitehub] ${JSON.stringify(address.field)} is not a Content field path. Use dots between keys, such as hero.title.`)
  if (address.id !== undefined && (!address.id || address.id.includes("#"))) throw new TypeError(`[vitehub] ${JSON.stringify(address.id)} is not a Content document id.`)
  return `${address.collection}${address.id === undefined ? "" : `:${address.id}`}#${address.field}`
}

/** Reads a field address that `contentField()` wrote. Returns undefined for anything else. */
export function parseContentField(value: string): ContentFieldAddress | undefined {
  const hash = value.lastIndexOf("#")
  if (hash <= 0) return
  const field = value.slice(hash + 1)
  const head = value.slice(0, hash)
  const colon = head.indexOf(":")
  const collection = colon === -1 ? head : head.slice(0, colon)
  const id = colon === -1 ? undefined : head.slice(colon + 1)
  if (!collectionName.test(collection) || !fieldPath.test(field) || id === "") return
  return id === undefined ? { collection, field } : { collection, id, field }
}
