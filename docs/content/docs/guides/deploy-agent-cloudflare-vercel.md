---
title: Deploy an Agent on Cloudflare and Vercel
description: Keep one TypeScript Agent and HTTP route while changing the ViteHub deployment preset for Cloudflare Workers or Vercel.
navigation.title: Deploy an Agent
navigation.order: 2
navigation.group: Agents
icon: i-lucide-cloud-upload
---

Deploy the same greeting Agent on Cloudflare Workers and Vercel. The Agent and
route stay the same. The preset selects the deployment output.

Start with the Vite app from [Installation](/docs/getting-started/installation).
Use its pinned Nitro and H3 versions, Node.js 24.15 or newer, and pnpm.
This example uses a function Driver. It checks Agent execution without a model
account. Deployment requires an account with the selected host.

## Define the Agent and route

Create the Agent:

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

Create the route. The two-argument `runAgent()` call returns an error tuple.

```ts [server/api/greet.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runAgent } from 'vite-hub/agent'
import greeting from '../agents/greeting'

export default defineEventHandler(async (event) => {
	const body = await readBody<{ name?: unknown }>(event)
	const name = typeof body?.name === 'string' ? body.name : 'friend'
	const [error, result] = await runAgent(greeting, { prompt: name })
	if (error) throw error
	return result
})
```

## Build for Cloudflare Workers

Select the Cloudflare preset. Disable Workflow because this Agent finishes
inside the request. Disable Console so this check needs no invocation journal.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
	plugins: [vitehub({
		name: 'vitehub-greeting',
		preset: 'cloudflare',
		agent: true,
		workflow: false,
		console: false,
	})],
})
```

Build the app and confirm that it writes the Worker configuration:

```bash [Terminal]
pnpm build
test -f .output/server/wrangler.json
```

Authenticate with Cloudflare through its deployment tools. Review the generated
Worker name and account before deploying. Deployment can incur host charges.

```bash [Terminal]
pnpm exec nitro deploy --prebuilt
```

Use the generated Nitro deployment command. Read
[Cloudflare](/docs/frameworks-hosts/cloudflare) before adding bindings, Sandbox,
or provisioning to this app.

## Build for Vercel

Change only `preset: 'cloudflare'` to `preset: 'vercel'` in the config above.
Keep the same Agent, route, and other options.

Use the Vercel CLI to link the project and pull its preview configuration:

```bash [Terminal]
pnpm dlx vercel link
pnpm dlx vercel pull --environment=preview
pnpm build
test -f .vercel/output/config.json
pnpm dlx vercel deploy --prebuilt
```

Review the linked project before deploying. This command creates a preview
deployment. Read [Vercel](/docs/frameworks-hosts/vercel) for hosted storage and
environment variables.

## Check each deployment

Set `APP_URL` to the deployment URL. If the host protects preview deployments,
supply the host's access credentials before this check.

```bash [Terminal]
curl --fail-with-body "$APP_URL/api/greet" \
  -H 'content-type: application/json' \
  -d '{"name":"Ada"}'
```

The response contains:

```json [Response]
{ "text": "Hello, Ada." }
```

Repeat the request against both hosts. Check the host logs if a deployment
returns an error. A successful build alone does not prove that the route runs.

## Add model calls and persistent state

Replace the function Driver with a [model Driver](/docs/agents/agent-drivers)
when the deployment check passes. Set model credentials in each host's server
environment. Model requests can incur separate charges.

Keep this inline form for work that fits the host's request duration. Use
[Workflow](/docs/workflows) when work must continue beyond the request.
Choose persistent stores before adding history or memory.

The Codex and Claude Code provider Drivers need a local Node.js process and
their documented runtime dependencies. This Worker example does not run them.
Check [runtime support](/docs/frameworks-hosts/support-matrix) before changing
the Driver or adding a feature.
