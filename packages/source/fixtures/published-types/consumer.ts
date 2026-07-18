import { SourceError, SourceNotFoundError } from "@vite-hub/source"

import type { SourceErrorCode, SourceErrorOptions, SourceProviderOperation, SourceValueType } from "@vite-hub/source"

const options: SourceErrorOptions<"SOURCE_ITEM_NOT_FOUND"> = {
  code: "SOURCE_ITEM_NOT_FOUND",
  details: { key: "README.md", source: "docs" },
}

const error = new SourceError({
  ...options,
  message: "Missing source item",
})
error.code satisfies SourceErrorCode
error.toJSON().details?.key satisfies string | undefined
"read-item" satisfies SourceProviderOperation
"string" satisfies SourceValueType

new SourceError("Missing source item", options)

class ConsumerSourceError extends SourceError<"SOURCE_ITEM_NOT_FOUND"> {
  constructor() {
    super({
      ...options,
      message: "Missing source item",
    })
  }
}

new ConsumerSourceError()
new SourceNotFoundError("docs")

new SourceError({
  code: "SOURCE_PROVIDER_REQUEST_FAILED",
  // @ts-expect-error Provider operations use the closed Source vocabulary.
  details: { operation: "refresh-token", provider: "github" },
  message: "Provider failed.",
})

new SourceError({
  code: "SOURCE_ITEM_NOT_FOUND",
  // @ts-expect-error Built-in details do not accept arbitrary fields.
  details: { key: "README.md", token: "secret-token" },
  message: "Missing source item",
})
