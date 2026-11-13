import { mediaUrl } from "../../site"

// The illustrations in the media library of the Console, at `illustrations/<name>-light.svg` and `-dark.svg`.
// scripts/upload-illustrations.mjs uploads them from illustrations/svg/ with the alt text of illustrations/alt.json.
export const illustrationNames = ["hero", "getting-started", "guides", "reference", "edit-this-site"] as const
export type IllustrationName = typeof illustrationNames[number]

export function illustrationUrls(name: string): { light: string, dark: string } {
  return { light: mediaUrl(`illustrations/${name}-light.svg`), dark: mediaUrl(`illustrations/${name}-dark.svg`) }
}

/** Dates of posts and releases, the same on the server and in the browser. */
export function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
}
