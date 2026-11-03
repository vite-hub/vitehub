---
title: Send email with Resend and ViteHub
description: Configure Resend as the ViteHub Email provider, keep its API key in server secrets, and verify delivery after deployment.
navigation.title: Resend
navigation.order: 20
navigation.group: Server work
icon: i-lucide-mail
---

Use the built-in Resend driver to send transactional email from a ViteHub app.
The server calls `email.send()`. The deployment configuration supplies the
provider and credential.

Complete [Send your first Email](/docs/email/get-started) for a local message.
You need a Resend API key, a verified sender, and an inbox you control.
Sending a message uses your Resend account and can incur charges.

## Keep the credential in server secrets

Use a runtime Env source instead of a literal key:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
	plugins: [vitehub({
		preset: 'vercel',
		email: {
			driver: 'resend',
			options: {
				apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }),
			},
		},
	})],
})
```

Set `RESEND_API_KEY` in the deployed server environment. Keep the same explicit
driver if you change to `node`, `netlify`, or another supported host.
On Cloudflare, `email: true` selects Cloudflare Email, so keep the explicit
`resend` configuration when Resend is the intended provider.

## Send a deployment check

Keep the welcome route from the Email tutorial. Replace its sender with an
address on your verified domain and its recipient with your test inbox.

Set `APP_URL` to the deployment URL and send one request:

```bash [Terminal]
curl --fail-with-body -X POST "$APP_URL/api/welcome"
```

The response contains a provider message ID and `driver: 'resend'`. Check that
ID in Resend's delivery log and confirm the message in the inbox. An accepted
ID alone does not prove delivery.

## Diagnose delivery problems

- For an authentication failure, check the key in the deployed environment.
- For a sender error, check the domain and sender in Resend.
- For an accepted message with no inbox delivery, inspect the provider events
  and the recipient's spam folder.

The tutorial route sends a message on every request. Add access control before
using it in a public app. For retried jobs, record your send decision and use
the provider's supported deduplication controls to prevent duplicate messages.

Read [Email hosts](/docs/email/hosts) for development capture and provider
behavior, and [Resend documentation](https://resend.com/docs) for domain
verification, delivery events, and limits.
