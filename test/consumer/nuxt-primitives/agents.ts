import { pending, type PrimitiveEntry } from "./row.ts"

export const agents: PrimitiveEntry[] = [
  ...pending("U7", ["agent", "channels", "connections", "gateways", "mcp", "choices"]),
]
