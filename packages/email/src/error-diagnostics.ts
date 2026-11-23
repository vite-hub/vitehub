import { defineErrors } from "@vite-hub/runtime"

const driverProblems = {
  "definition": "`createEmail()` expects an object with a `driver`.",
  "name": "The Email driver name must be a non-empty string.",
  "not-object": "The Email driver must be an object.",
  "send": "The Email driver `send` must be a function.",
} as const

const outboxProblems = {
  deliver: "`email.outbox.deliver` was removed. `vite dev` keeps sends in the outbox unless `email.remote` is `true`.",
  limit: "`email.outbox.limit` must be an integer from 1 to 1000.",
  type: "`email.outbox` must be `false` or an object.",
} as const

const frontmatterProblems = {
  key: (key: string) => `Email templates read only \`subject\` from frontmatter, and this template sets \`${key}\`.`,
  subject: () => "The `subject` frontmatter of an Email template must be a string.",
} as const

export type EmailDriverProblem = keyof typeof driverProblems
export type EmailOutboxProblem = keyof typeof outboxProblems
export type EmailFrontmatterProblem = keyof typeof frontmatterProblems

export const emailErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/email/diagnostics",
  codes: {
    // Runtime errors.
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
    EMAIL_TEMPLATE_RENDER_FAILED: {
      why: ({ template }: { template: string }) => `Email template "${template}" could not render with the \`data\` of this message.`,
      fix: "Read `error.cause` for the binding that failed. Pass a string, number, or boolean for each `{{ data.* }}` binding, and a string for each `:insert` binding.",
    },
    EMAIL_TIMEOUT: {
      why: ({ driver }: { driver: string }) => `Email delivery through ${driver} timed out.`,
      fix: "The provider can have accepted the message. Check its delivery logs, or retry with the same `idempotencyKey`.",
    },

    // Operation errors.
    EMAIL_OUTBOX_DISABLED: {
      why: "The Email development outbox is disabled.",
      fix: "Remove `email.outbox: false` to capture messages in `vite dev`.",
    },
    EMAIL_OUTBOX_MESSAGE_NOT_FOUND: {
      why: "Outbox message was not found. The outbox keeps only recent messages and a restart clears it.",
      fix: "Run `vitehub email outbox list` for the ids that the outbox holds.",
    },
    EMAIL_TEMPLATE_NOT_FOUND: {
      why: ({ available, roots, template }: { available: string, roots: string, template: string }) => `Email template "${template}" was not found in ${roots}. ${available ? `Templates: ${available}.` : "No templates were found."}`,
      fix: "Pass the path under server/emails without `.md`, for example `welcome` for `server/emails/welcome.md`. Files and folders that start with `_` are partials, not templates.",
    },
    EMAIL_TEMPLATE_SUBJECT_REQUIRED: {
      why: ({ template }: { template: string }) => `Email template "${template}" has no \`subject:\` frontmatter, and the message has no \`subject\`.`,
      fix: "Add `subject:` frontmatter to the template, or pass `subject` to `email.send()`.",
    },

    // Config errors.
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

    // Build errors.
    EMAIL_DUPLICATE_TEMPLATE: {
      why: ({ name }: { name: string }) => `Two Email templates have the name ${JSON.stringify(name)}.`,
      fix: "Rename or remove one of the two template files under `server/emails`.",
    },
    EMAIL_HOST_UNSUPPORTED: {
      why: "The \"cloudflare\" driver needs a Cloudflare host.",
      fix: "Deploy to Cloudflare, or use the \"resend\" driver.",
    },
    EMAIL_INVALID_OUTBOX: {
      why: ({ problem }: { problem: EmailOutboxProblem }) => outboxProblems[problem],
      fix: "Set `email.outbox` to `false`, or to `{ limit }`. To send `vite dev` email through the provider, set `email.remote: true`.",
    },
    EMAIL_INVALID_REMOTE: {
      why: "`email.remote` must be a boolean.",
      fix: "Set `email.remote: true` to send `vite dev` email through the provider, or remove it to keep dev sends in the outbox.",
    },
    EMAIL_INVALID_TEMPLATE: {
      why: ({ id }: { id: string }) => `The Email template import ${JSON.stringify(id)} is not valid.`,
      fix: "Import `#vitehub/emails/<name>`, where `<name>` is the path under `server/emails` without `.md`. Files and folders that start with `_` are partials, so they have no import.",
    },
    EMAIL_REMOTE_REQUIRED: {
      why: "`email.outbox` is `false`, so a `vite dev` send has no outbox to stay in.",
      fix: "Remove `outbox: false` to keep dev sends in the outbox, or set `email.remote: true` to send them through the provider.",
    },
    EMAIL_SECRET_DEFAULT: {
      why: ({ path }: { path: string }) => `The secret Email option ${path} has a default, and defaults are included in build output.`,
      fix: "Remove the default, and set the secret in the host environment.",
    },
    EMAIL_SYNC_OPTION_REQUIRED: {
      why: ({ path }: { path: string }) => `The Email option ${path} uses \`env.provider()\`, and Email resolves its options synchronously.`,
      fix: "Read the value with `env.source()`, for example `env({ secret: true, source: env.source('RESEND_API_KEY') })`.",
    },
    EMAIL_TEMPLATE_FRONTMATTER_INVALID: {
      why: ({ file, key, problem }: { file?: string, key: string, problem: EmailFrontmatterProblem }) =>
        `${file === undefined ? "" : `${file}: `}${frontmatterProblems[problem](key)}`,
      fix: "Keep only `subject:` in the frontmatter, as one string such as `subject: Welcome {{ data.user.name }}`.",
    },
    EMAIL_TEMPLATE_SYNTAX_INVALID: {
      why: ({ file }: { file: string }) => `The Email template ${file} cannot render with any \`data\`.`,
      fix: "Read `error.cause` for the binding or block to change, and fix the template file. A template reads each value as `{{ data.<name> }}`, outside inline code and code blocks.",
    },
    EMAIL_UNKNOWN_DRIVER: {
      why: ({ driver, renamed }: { driver: string, renamed?: string }) => renamed
        ? `\`email.driver\` is ${driver}. ViteHub renamed this driver to "${renamed}", and it does not read ${driver}.`
        : `The Email \`driver\` is ${driver}. It must be "resend", "cloudflare", or "log".`,
      fix: ({ renamed }: { driver: string, renamed?: string }) => renamed
        ? `Set \`email: { driver: "${renamed}" }\`, or run \`npx @vite-hub/codemods driver-key\` to rename it in every config file.`
        : "Set `email: { driver: 'resend' }` or `email: { driver: 'cloudflare' }`. Set `email: { driver: 'log' }` to print messages and send nothing.",
    },

    // Tool errors.
    EMAIL_CLI_USAGE: {
      why: ({ problem }: { problem: string }) => problem,
      fix: "Run `vitehub email --help` to see the commands and options.",
    },
  },
})
