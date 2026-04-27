---
title: Workflow troubleshooting
description: Fix unknown workflows, disabled runtime config, missing Cloudflare bindings, and provider mismatches.
navigation.title: Troubleshooting
navigation.order: 5
icon: i-lucide-wrench
frameworks: [vite, nitro]
---

Most Workflow issues come from discovery paths, provider config, or deployment output that does not match the selected provider.

## Unknown workflow definition

`WORKFLOW_DEFINITION_NOT_FOUND` means the runtime registry does not contain the name passed to `runWorkflow()` or `getWorkflowRun()`.

Check the discovered file path:

::fw{id="vite:dev vite:build"}
- `src/welcome.workflow.ts` is named `welcome`
- `src/email/welcome.workflow.ts` is named `email/welcome`
- `server/workflows/welcome.ts` is named `welcome`
::

::fw{id="nitro:dev nitro:build"}
- `server/workflows/welcome.ts` is named `welcome`
- `server/workflows/email/welcome.ts` is named `email/welcome`
::

Make sure the file has a default export created with `defineWorkflow()`.

## Workflow is disabled

`WORKFLOW_DISABLED` means the app was built or started with:

```ts
workflow: false
```

Remove the setting or provide a provider config:

```ts
workflow: {
  provider: 'cloudflare',
}
```

## Unknown provider

Only `cloudflare` and `vercel` are valid providers:

```ts
workflow: {
  provider: 'vercel',
}
```

When `provider` is omitted, Cloudflare hosting selects Cloudflare and every other hosting target selects Vercel.

## Missing Cloudflare binding

If Cloudflare status is always local or unknown, verify that generated `wrangler.json` includes the workflow binding:

```json
{
  "workflows": [
    {
      "binding": "WORKFLOW_77656C636F6D65",
      "name": "workflow--77656c636f6d65",
      "class_name": "ViteHubWelcomeWorkflow"
    }
  ]
}
```

If you override `workflow.binding`, the runtime expects that exact binding name in Cloudflare `env`.

## Deferred run did not start

`deferWorkflow()` schedules the start through `waitUntil()` when the runtime provides it. If no request context is active, dispatch still runs asynchronously and errors are logged.

Use `runWorkflow()` when the route must fail if the workflow cannot be started:

```ts
const run = await runWorkflow('welcome', payload)
```

## Status is unknown

`unknown` means the active provider could not resolve status for that run id.

Common causes:

- The run id came from another deployment or runtime process.
- The Cloudflare binding is missing from the request environment.
- The provider accepted the start but does not expose status metadata for that run.

Persist run ids and application-level completion state when the UI needs a durable cross-deployment history.
