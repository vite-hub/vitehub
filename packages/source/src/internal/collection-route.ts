export function encodeCollectionRouteSegment(segment: string): string {
  return encodeURIComponent(segment).replaceAll("*", "%2A")
}
