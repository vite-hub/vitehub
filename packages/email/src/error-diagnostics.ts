import { defineErrors } from "@vite-hub/runtime"

const driverProblems = {
  "definition": "`createEmail()` expects an object with a `driver`.",
  "name": "The Email driver name must be a non-empty string.",
  "not-object": "The Email driver must be an object.",
  "send": "The Email driver `send` must be a function.",
} as const

const outboxProblems = {
  deliver: "`email.outbox.deliver` must be a boolean.",
  limit: "`email.outbox.limit` must be an integer from 1 to 1000.",
  type: "`email.outbox` must be `false` or an object.",
} as const

export type EmailDriverProblem = keyof typeof driverProblems
export type EmailOutboxProblem = keyof typeof outboxProblems

// Keep published codes stable. Each code has a heading on the docs page.
export const emailErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/email/limits-and-errors",
  codes: {
    // Runtime errors. `send()` returns them as `[error, undefined]`.
    EMAIL_AUTHENTICATION: {
      why: ({ driver }: { driver: string }) => `The ${driver} Email provider rejected the credentials.`,
      fix: "Check the API key or binding of the driver, and check that the provider authorizes the sender.",
    },
    EMAIL_INVALID_MESSAGE: {
      why: ({ driver }: { driver: string }) => `The ${driver} Email driver rejected the message.`,
      fix: "Read `error.cause` for the field that is not valid, and correct the message. Do not retry the same message.",
    },
    EMAIL_NETWORK: {
      why: ({ driver }: { driver: string }) => `The ${driver} Email driver could not reach its provider.`,
      fix: "Check DNS and outbound network access. The provider can have accepted the message, so check its delivery logs before you retry.",
    },
    EMAIL_PROVIDER_FAILED: {
      why: ({ driver }: { driver: string }) => `Email delivery through ${driver} failed.`,
      fix: "Read `error.cause` in server logs, and check the delivery logs of the provider.",
    },
    EMAIL_RATE_LIMITED: {
      why: ({ driver }: { driver: string }) => `The ${driver} Email provider rate limited the request.`,
      fix: "Retry later with backoff, for example from a Queue.",
    },
    EMAIL_TIMEOUT: {
      why: ({ driver }: { driver: string }) => `Email delivery through ${driver} timed out.`,
      fix: "The provider can have accepted the message. Check its delivery logs, or retry with the same `idempotencyKey`.",
    },

    // Config errors. Email throws them because the code or the deployment must change.
    EMAIL_INVALID_DRIVER: {
      why: ({ problem }: { problem: EmailDriverProblem }) => driverProblems[problem],
      fix: "Pass a driver from `@vite-hub/email/drivers/*`, or an object with a `name` and a `send()` function.",
    },
    EMAIL_NOT_CONFIGURED: {
      why: ({ driver }: { driver?: string }) => driver === undefined
        ? "No Email provider is configured."
        : `The options of the ${driver} Email driver are not valid.`,
      fix: "Set `vitehub({ email: { driver, options } })`, and check the driver options. `error.cause` tells which option is not valid.",
    },

    // Build errors. The Vite plugin throws them.
    EMAIL_DUPLICATE_TEMPLATE: {
      why: ({ name }: { name: string }) => `Two Email templates have the name ${JSON.stringify(name)}.`,
      fix: "Rename or remove one of the two Markdown files under `server/emails`.",
    },
    EMAIL_HOST_UNSUPPORTED: {
      why: "The \"cloudflare-email\" driver needs a Cloudflare host.",
      fix: "Deploy to Cloudflare, or use the \"resend\" driver.",
    },
    EMAIL_INVALID_OUTBOX: {
      why: ({ problem }: { problem: EmailOutboxProblem }) => outboxProblems[problem],
      fix: "Set `email.outbox` to `false`, or to `{ deliver, limit }`.",
    },
    EMAIL_INVALID_TEMPLATE: {
      why: ({ id }: { id: string }) => `The Email template import ${JSON.stringify(id)} is not valid.`,
      fix: "Import `#vitehub/emails/<name>`, where `<name>` is the path under `server/emails` without `.md`.",
    },
    EMAIL_SECRET_DEFAULT: {
      why: ({ path }: { path: string }) => `The secret Email option ${path} has a default, and defaults are included in build output.`,
      fix: "Remove the default, and set the secret in the host environment.",
    },
    EMAIL_SYNC_OPTION_REQUIRED: {
      why: ({ path }: { path: string }) => `The Email option ${path} uses \`env.provider()\`, and Email resolves its options synchronously.`,
      fix: "Read the value with `env.source()`, for example `env({ secret: true, source: env.source('RESEND_API_KEY') })`.",
    },
    EMAIL_UNKNOWN_DRIVER: {
      why: "The Email `driver` must be \"resend\" or \"cloudflare-email\".",
      fix: "Set `email: { driver: 'resend' }` or `email: { driver: 'cloudflare-email' }`.",
    },

    // Tool errors.
    EMAIL_CLI_USAGE: {
      why: ({ problem }: { problem: string }) => problem,
      fix: "Run `vitehub email --help` to see the commands and options.",
    },
  },
})
