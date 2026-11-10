// `createError()` returns an H3 `HTTPError`, the one error that H3 answers with its own status.
import { createError } from "h3"

import type { HTTPError } from "h3"

const reasonPhrase = /^[\t\x20-\x7E]{1,512}$/

/** The diagnostic fields that a Console HTTP error keeps from its cause. */
interface ConsoleErrorCause extends Error {
  code?: string
  docs?: string
  fix?: string
  why?: string
}

/** A Console HTTP error: an H3 `HTTPError` that also has the diagnostic fields of its cause. */
export type ConsoleHttpError = HTTPError & Pick<ConsoleErrorCause, "code" | "docs" | "fix" | "why">

/**
 * Turns an error into the HTTP error of a Console route. H3 marks a thrown error that is not its `HTTPError` as
 * unhandled, and Nitro then answers 500 without the message. The result keeps `code`, `why`, `fix`, and `docs` of a
 * diagnostic, on the error and in the JSON body.
 */
export function consoleHttpError(status: number, cause: ConsoleErrorCause): ConsoleHttpError {
  const { code, docs, fix, message, why } = cause
  // H3 strips characters that a reason phrase cannot hold, so only a message without them is also the status text.
  const statusText = reasonPhrase.test(message) ? message : undefined
  return Object.assign(createError({ body: { code, docs, fix }, cause, message, status, statusText }), { code, docs, fix, why })
}
