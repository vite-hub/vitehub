---
title: Send email with Resend and ViteHub
description: Configure Resend as the ViteHub Email provider, keep its API key in server secrets, and verify delivery after deployment.
navigation.title: Resend
navigation.order: 20
navigation.group: Server work
icon: i-lucide-mail
---

Use the built-in Resend driver to send transactional email. Your server calls
`email.send()`, and the config picks the provider and key.

First, complete [Send your first Email](/docs/email/get-started). You need a
Resend API key, a verified sender, and an inbox you control. Each message uses
your Resend account and can cost money.

## Keep the credential in server secrets

Read the key from the environment at runtime, not from a literal:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
  	host: 'vercel',
  	email: {
  		driver: 'resend',
  		options: {
  			apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }),
  		},
  	},
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
	plugins: [vitehub({
		host: 'vercel',
		email: {
			driver: 'resend',
			options: {
				apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }),
			},
		},
	}), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
	plugins: [vitehub({
		host: 'vercel',
		email: {
			driver: 'resend',
			options: {
				apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }),
			},
		},
	})],
})
```
:::
::

Set `RESEND_API_KEY` in the server environment. Keep `driver: 'resend'` when
you move to `node`, `netlify`, or another host. On Cloudflare, `email: true`
picks Cloudflare Email instead.

## Send a deployment check

In the tutorial's welcome route, set the sender to an address on your verified
domain and the recipient to your test inbox. Set `APP_URL` to the deployment
URL and send one request:

```bash [Terminal]
curl --fail-with-body -X POST "$APP_URL/api/welcome"
```

The response has a message ID and `driver: 'resend'`. Find that ID in
Resend's delivery log and the message in the inbox. An ID alone does not prove
delivery.

## Diagnose delivery problems

- Authentication failure: check the key in the deployed environment.
- Sender error: check the domain and sender in Resend.
- Accepted but not in the inbox: check the provider events and the spam folder.

The tutorial route sends a message on every request, so add access control
before you make it public. In retried jobs, save your send decision and use
the provider's deduplication to avoid duplicates.

See [Email hosts](/docs/email/hosts) for dev capture and provider behavior, and
the [Resend docs](https://resend.com/docs) for domains, delivery events, and
limits.
