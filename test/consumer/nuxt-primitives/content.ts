import { pending, type PrimitiveEntry } from "./row.ts"

export const content: PrimitiveEntry[] = [
  ...pending("U8", ["content", "docs", "i18n", "source", "workspace", "cms", "seo", "markdown-template", "web-container"]),
]
