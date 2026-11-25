import { pending, type PrimitiveEntry } from "./row.ts"

export const ops: PrimitiveEntry[] = [
  ...pending("U10", ["console", "logs", "device", "forge", "shell", "browser", "bundle", "observability"]),
]
