import { HTTPError } from "h3"

import type { AbilityCheckRefusal } from "./ability-check.ts"

const statusTexts: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  422: "Unprocessable Content",
  423: "Locked",
  429: "Too Many Requests",
  451: "Unavailable For Legal Reasons",
}

/** The code and details of a refusal, as the error body's `data` and the `#denied` slot of `<Can>` carry them. */
export interface AbilityErrorData {
  code?: string
  details?: unknown
}

/**
 * The error that `requireAbility()` throws when a rule refuses. H3 2 and Nitro answer it like their own `HTTPError`:
 * the rule's status, and `{ code, details }` in `data`. Other hosts can catch it and read `status` and `data`.
 */
export class AbilityError extends HTTPError<AbilityErrorData> {
  declare readonly statusText: string
  declare readonly data: AbilityErrorData

  constructor(refusal: AbilityCheckRefusal) {
    const statusText = statusTexts[refusal.status] ?? "Forbidden"
    super({
      message: `${statusText}.`,
      status: refusal.status,
      statusText,
      data: { code: refusal.code, details: refusal.details },
    })
  }

  get statusCode(): number {
    return this.status
  }

  get statusMessage(): string {
    return this.statusText
  }

  toJSON(): { status: number, statusText: string, message: string, data: AbilityErrorData } {
    return { status: this.status, statusText: this.statusText, message: this.message, data: this.data }
  }
}
