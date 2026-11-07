import { compileMessage } from "@lingui/message-utils/compileMessage"

import type { Messages } from "@lingui/core"
import type { SourceMessages } from "./manifest.ts"
import type { TranslationRecords } from "./records.ts"

/**
 * Compiled messages of one locale. With `sources`, a message without a translation gets its source text, so a page
 * that ships only message IDs never shows an ID.
 */
export function compileMessages(records: TranslationRecords, sources?: SourceMessages): Messages {
  const messages: Messages = {}
  if (sources) for (const [id, source] of Object.entries(sources)) messages[id] = compileMessage(source.message)
  for (const [id, record] of Object.entries(records)) {
    if (record.translation !== "" && (!sources || id in sources)) messages[id] = compileMessage(record.translation)
  }
  return messages
}
