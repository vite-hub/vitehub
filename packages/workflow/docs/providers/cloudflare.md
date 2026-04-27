---
title: Cloudflare
description: Configure @vitehub/workflow for Cloudflare Workflows, generated Wrangler bindings, and workflow entrypoint classes.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 0
icon: i-simple-icons-cloudflare
frameworks: [vite, nitro]
---

Cloudflare hosting selects the Cloudflare provider automatically. You can also set it explicitly when local builds should emit Cloudflare output.

::tabs{sync="framework"}
  :::tabs-item{label="Vite" icon="i-simple-icons-vite" class="p-4"}
    ```ts [vite.config.ts]
    import { defineConfig } from 'vite'
    import { hubWorkflow } from '@vitehub/workflow/vite'

    export default defineConfig({
      plugins: [hubWorkflow()],
      workflow: {
        provider: 'cloudflare',
      },
    })
    ```
  :::

  :::tabs-item{label="Nitro" icon="i-simple-icons-nuxtdotjs" class="p-4"}
    ```ts [nitro.config.ts]
    import { defineNitroConfig } from 'nitro/config'

    export default defineNitroConfig({
      modules: ['@vitehub/workflow/nitro'],
      workflow: {
        provider: 'cloudflare',
      },
    })
    ```
  :::
::

## Generated output

For each discovered workflow, ViteHub generates a Cloudflare Workflow binding in `wrangler.json`:

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

The build also emits workflow entrypoint classes that load the generated registry and call the matching `defineWorkflow()` handler.

## Naming

Cloudflare names are derived from the discovered workflow name:

| Workflow | Binding | Name | Class |
| --- | --- | --- | --- |
| `welcome` | `WORKFLOW_77656C636F6D65` | `workflow--77656c636f6d65` | `ViteHubWelcomeWorkflow` |
| `email/welcome` | `WORKFLOW_656D61696C2F77656C636F6D65` | `workflow--656d61696c2f77656c636f6d65` | `ViteHubEmailWelcomeWorkflow` |

Use `binding` or `name` only when an existing deployment already has a required convention:

```ts
workflow: {
  provider: 'cloudflare',
  binding: 'WORKFLOW_WELCOME',
  name: 'workflow-welcome',
}
```

## Handler context

Cloudflare runs receive `provider: 'cloudflare'` and pass the provider step object when it is available:

```ts
export default defineWorkflow<WelcomePayload>(async ({ payload, step }) => {
  await step?.do?.('send welcome email', async () => {
    console.log(payload.email)
  })
})
```

Keep the handler portable by checking for provider step helpers before using them.

## Runtime calls

`runWorkflow()` starts the generated Cloudflare binding when it exists:

```ts
const run = await runWorkflow('welcome', payload)
```

`getWorkflowRun()` calls the binding `get(id)` and normalizes Cloudflare status metadata to `queued`, `running`, `completed`, `failed`, or `unknown`.

::callout{icon="i-lucide-alert-triangle" color="warning"}
If the binding is missing, the runtime falls back to the generated registry so local and preview builds can still exercise the same application API.
::
