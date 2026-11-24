const startCursor = "~vitehub:start~"

export function toProviderListCursor(cursor: string | undefined) {
  if (cursor === startCursor) return undefined
  return cursor?.startsWith(startCursor + startCursor) ? cursor.slice(startCursor.length) : cursor
}

export function fromProviderListCursor(cursor: string | undefined) {
  return cursor?.startsWith(startCursor) ? startCursor + cursor : cursor
}

export function unconsumedListCursor(cursor: string | undefined) {
  return cursor ?? startCursor
}
