/** The public origin of the demo Worker. Auth, the Console MCP, and the docs links use it. */
export const publicUrl = "https://docs-demo.vitehub.dev"

/** The route that serves the `media` Blob store, the media library of the Console. */
export const mediaRoute = "/media"

/** The URL of a media library file, such as `illustrations/hero-light.svg`. */
export function mediaUrl(pathname: string): string {
  return `${mediaRoute}/${pathname.split("/").map(encodeURIComponent).join("/")}`
}
