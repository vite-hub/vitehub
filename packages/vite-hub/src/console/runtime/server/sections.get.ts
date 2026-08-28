import { assertConsoleRequest } from "./request.ts"
import { getConsoleSections } from "./sections.ts"

import type { ConsoleRequestEvent } from "./request.ts"

export default function consoleSectionsHandler(event: ConsoleRequestEvent): {
  sections: readonly string[]
} {
  assertConsoleRequest(event)
  return { sections: getConsoleSections() }
}
