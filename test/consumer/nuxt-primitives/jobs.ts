import { pending, type PrimitiveEntry } from "./row.ts"

export const jobs: PrimitiveEntry[] = [
  ...pending("U6", ["queue", "schedule", "workflow", "sandbox", "realtime"]),
]
