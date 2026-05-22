import { analyzeShellCommand } from "./command/analyze.ts"
import { createShellRuntime } from "./runtime/index.ts"

export type * from "./runtime/types.ts"

export {
  analyzeShellCommand,
  createShellRuntime,
}
