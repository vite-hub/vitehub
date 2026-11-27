import { getLocale, plural, t } from "@vite-hub/i18n"

export function deployStatus(count: number): string {
  return `${t`Deploy finished`} (${getLocale()}): ${plural(count, { one: "# agent", other: "# agents" })}`
}
