import { addresses, formatAddress } from "./shared.ts"

import type { EmailDriver } from "../types.ts"

/**
 * Prints each message to the server log with `console.info` and sends nothing. Use it for a build without an Email
 * provider. The send succeeds, and `email.canSend` is `false`, so the app can show a link on the page instead. The log
 * keeps the body, so links in the message, such as sign-in links, are in the log.
 */
export default function logEmailDriver(): EmailDriver {
  return {
    name: "log",
    send(message) {
      const to = addresses(message.to).map(formatAddress).join(", ")
      console.info(`[vitehub] Email log driver. Not sent to ${to}: ${message.subject}\n${message.text ?? message.html}`)
      return [undefined, { at: new Date(), driver: "log", id: `log-${crypto.randomUUID()}` }]
    },
  }
}
