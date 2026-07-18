import { SourceError, SourceNotFoundError } from "@vite-hub/source"

import type { SourceErrorCode, SourceErrorOptions } from "@vite-hub/source"

const options: SourceErrorOptions<"SOURCE_ITEM_NOT_FOUND"> = {
  code: "SOURCE_ITEM_NOT_FOUND",
  details: { key: "README.md", source: "docs" },
}

const error = new SourceError("Missing source item", options)
error.code satisfies SourceErrorCode
error.toJSON().details?.key satisfies string | undefined

class ConsumerSourceError extends SourceError<"SOURCE_ITEM_NOT_FOUND"> {
  constructor() {
    super("Missing source item", options)
  }
}

new ConsumerSourceError()
new SourceNotFoundError("docs")
