export function encodeCollectionRouteSegment(segment: string): string {
  return encodeURIComponent(segment).replaceAll("*", "%2A")
}

/** Generated GET route of a discovered Collection, for example `/api/articles`. */
export function collectionRoutePath(name: string): string {
  return `/api/${name.split("/").map(encodeCollectionRouteSegment).join("/")}`
}
