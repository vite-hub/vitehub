export function normalizeHosting(hosting: string | undefined): string {
  return hosting?.trim().toLowerCase().replaceAll("_", "-") || ""
}
