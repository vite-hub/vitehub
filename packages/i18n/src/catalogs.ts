import { compileMessage } from "@lingui/message-utils/compileMessage"

import { isVisible } from "./record-format.ts"

import type { Messages } from "@lingui/core"
import type { SourceMessages } from "./manifest.ts"
import type { TranslationRecords } from "./record-format.ts"

/**
 * Compiled messages of one locale. With `sources`, a message without a translation gets its source text, so a page
 * that ships only message IDs never shows an ID. A rejected translation, or one that fails Diglot's validation, also
 * shows the source text.
 */
export function compileMessages(records: TranslationRecords, sources?: SourceMessages): Messages {
  const messages: Messages = {}
  if (sources) for (const [id, source] of Object.entries(sources)) messages[id] = compileMessage(source.message)
  for (const [id, record] of Object.entries(records)) {
    if ((!sources || id in sources) && isVisible(record)) messages[id] = compileMessage(record.text)
  }
  return messages
}
