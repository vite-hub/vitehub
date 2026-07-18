import { EmailError } from "@vite-hub/email"

import type {
  EmailErrorCode,
  EmailErrorDetails,
  EmailErrorMetadata,
  EmailErrorOptions,
} from "@vite-hub/email"

const details = {
  driver: "http",
  operation: "send",
} satisfies EmailErrorDetails

const options = {
  code: "provider",
  details,
  message: "Email delivery failed.",
} satisfies EmailErrorOptions

const metadata = {
  driver: "smtp",
} satisfies EmailErrorMetadata

const error = new EmailError(options)
error.code satisfies EmailErrorCode
error.toJSON().details?.driver satisfies string | undefined
new EmailError("network", "SMTP delivery failed.", metadata)
