---
description: "Fix EMAIL_NOT_CONFIGURED in ViteHub. email.send() has no Email provider, or the driver options are not valid. Configure the email option."
seo.title: "EMAIL_NOT_CONFIGURED: configure the Email provider"
---

`email.send()` throws `EMAIL_NOT_CONFIGURED`. The app has no Email provider, or the options of its Email driver are not valid. It is a configuration error, so it throws and does not come back as `[error, sent]`.

## Why it happens

`error.why` tells which case you have:

- `No Email provider is configured.` Email is off. `vitehub()` has no `email` option, or it has `email: false`. Then `vite-hub/email` loads an empty Email definition.
- `The options of the <driver> Email driver are not valid.` The driver rejected its options when ViteHub created it. `error.cause` names the option. The Resend driver needs an `apiKey` string that starts with `re_`, and an `endpoint` must be an HTTP or HTTPS URL. The Cloudflare Email driver needs the `EMAIL` binding in the Worker env.

In `vite dev` without `remote: true`, a send stays in the development outbox, and ViteHub does not create the driver. So invalid driver options show only in a build, or in `vite dev` with `remote: true`.

A required Env value that is not set fails in Server Env first. Then `email.send()` returns `EMAIL_PROVIDER_FAILED`, and `error.cause` has the code `ENV_REQUIRED_MISSING`.

## Fix it

```diff [vite.config.ts]
 import { vitehub } from 'vite-hub'
+import { env } from 'vite-hub/env'
 import { defineConfig } from 'vite'

 export default defineConfig({
-  plugins: [vitehub({ host: 'node' })],
+  plugins: [vitehub({
+    host: 'node',
+    email: {
+      driver: 'resend',
+      options: { apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
+    },
+  })],
 })
```

Add the `email` option. On the Cloudflare host, `email: true` selects the `cloudflare-email` driver and generates the `EMAIL` binding. Restart the dev server after you change the config.

```diff [vite.config.ts]
     email: {
       driver: 'resend',
-      options: { key: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
+      options: { apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
     },
```

For invalid options, read `error.cause` and correct that option. Set `RESEND_API_KEY` to your Resend API key, which starts with `re_`.

## Check the fix

Set `remote: true` in the `email` option, start `vite dev`, and call the route that sends the email. `email.send()` returns `[undefined, { id, driver }]` and does not throw. Then run `vitehub email outbox list`. The delivery of the message shows as sent, not failed.

## Related

- [Email configuration](/docs/email/configure#configure-vite)
- [Provide the Resend secret](/docs/email/get-started#provide-the-resend-secret)
- [Development outbox](/docs/email/hosts#development-outbox)
- [Email limits and errors](/docs/email/limits-and-errors)
- [`EMAIL_INVALID_DRIVER`](/docs/email/diagnostics/email_invalid_driver)
- [`EMAIL_PROVIDER_FAILED`](/docs/email/diagnostics/email_provider_failed)
