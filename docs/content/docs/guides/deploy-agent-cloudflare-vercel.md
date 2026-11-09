---
title: Deploy an Agent on Cloudflare and Vercel
description: Keep one TypeScript Agent and HTTP route while changing the ViteHub host for Cloudflare Workers or Vercel.
navigation.title: Deploy an Agent
navigation.order: 2
navigation.group: Agents
icon: i-lucide-cloud-upload
---

Deploy one greeting Agent on Cloudflare Workers and on Vercel. The Agent and
route stay the same. Only the host, which picks the host output, changes.

Start with the app from [Installation](/docs/getting-started/installation),
with its pinned Nitro and H3 versions, Node.js 22.22 or newer, and pnpm. A
function Driver (plain code that makes the reply) means you need no model
account, only an account with each host.

## Define the Agent and route

```ts [server/agents/greeting.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
	runtime: false,
	driver: {
		run({ prompt }) {
			const name = typeof prompt === 'string' ? prompt : 'friend'
			return { text: `Hello, ${name}.` }
		},
	},
})
```

Create the route. `runAgent()` returns an `[error, result]` tuple.

```ts [server/api/greet.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runAgent } from 'vite-hub/agent'
import greeting from '../agents/greeting'

export default defineEventHandler(async (event) => {
	const body = await readBody<{ name?: unknown }>(event)
	const name = typeof body?.name === 'string' ? body.name : 'friend'
	const [error, result] = await runAgent(greeting, { prompt: name })
	if (error) throw error
	return { text: result.text }
})
```

## Build for Cloudflare Workers

Select the Cloudflare host. Turn off Workflow, because this Agent finishes
inside the request. Turn off Console, so the check needs no run log.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
  	name: 'vitehub-greeting',
  	host: 'cloudflare',
  	agent: true,
  	workflow: false,
  	console: false,
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
	plugins: [vitehub({
		name: 'vitehub-greeting',
		host: 'cloudflare',
		agent: true,
		workflow: false,
		console: false,
	}), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
	plugins: [vitehub({
		name: 'vitehub-greeting',
		host: 'cloudflare',
		agent: true,
		workflow: false,
		console: false,
	})],
})
```
:::
::

Build and check that the Worker config exists:

```bash [Terminal]
pnpm build
test -f .output/server/wrangler.json
```

Log in to Cloudflare. Check the Worker name and account before you deploy.
Deploys can cost money.

```bash [Terminal]
pnpm exec nitro deploy --prebuilt
```

Read [Cloudflare](/docs/frameworks-hosts/cloudflare) before you add bindings,
Sandbox, or provisioning.

## Build for Vercel

Change `host: 'cloudflare'` to `host: 'vercel'` and keep everything else.
Link the project and pull its preview config with the Vercel CLI:

```bash [Terminal]
pnpm dlx vercel link
pnpm dlx vercel pull --environment=preview
pnpm build
test -f .vercel/output/config.json
pnpm dlx vercel deploy --prebuilt
```

Check the linked project before you deploy. This creates a preview deployment.
See [Vercel](/docs/frameworks-hosts/vercel) for hosted storage and environment
variables.

## Check each deployment

Set `APP_URL` to the deployment URL. If the host protects previews, add its
access credentials.

```bash [Terminal]
curl --fail-with-body "$APP_URL/api/greet" \
  -H 'content-type: application/json' \
  -d '{"name":"Ada"}'
```

The response contains:

```json [Response]
{ "text": "Hello, Ada." }
```

Run it on both hosts. On an error, check the host logs. A good build does not
prove that the route runs.

## Add model calls and persistent state

When the check passes, replace the function Driver with a
[model Driver](/docs/agents/agent-drivers). Set model credentials in each
host's server environment. Model requests cost extra.

Keep this inline form for work that fits in one request. Use
[Workflow](/docs/workflows) for work that must outlive the request. Choose
persistent stores before you add history or memory.

The Codex and Claude Code Drivers need a local Node.js process and their
runtime dependencies, so this Worker cannot run them. Check
[runtime support](/docs/frameworks-hosts/support-matrix) before you change the
Driver or add a feature.
