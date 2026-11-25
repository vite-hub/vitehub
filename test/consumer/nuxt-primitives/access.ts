import { pending, type PrimitiveEntry } from "./row.ts"

export const access: PrimitiveEntry[] = [
  ...pending("U9", ["auth", "comments", "forms", "webhooks", "email", "env"]),
]
