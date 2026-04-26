---
title: Sandbox troubleshooting
description: Diagnose provider inference, missing Cloudflare bindings, Vercel credentials, invalid definition options, and failed sandbox results.
navigation.title: Troubleshooting
navigation.order: 100
icon: i-lucide-wrench
frameworks: [vite, nitro]
---

Use this page by symptom. Each section gives the likely cause, the fix, and a quick verification step.

## `Sandbox provider could not be inferred`

**Cause:** Sandbox could not find an explicit provider, a `SANDBOX_PROVIDER` environment variable, a Cloudflare request environment, or a detectable provider runtime.

**Fix:** Configure the provider explicitly.

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubSandbox()],
  sandbox: {
    provider: 'cloudflare',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/sandbox/nitro'],
  sandbox: {
    provider: 'cloudflare',
  },
})
```
::

**Verify:** Call the sandbox route again. A provider-specific error means provider inference is fixed and setup has moved to the next issue.

## `Cloudflare sandbox requires the "SANDBOX" binding`

**Cause:** The Cloudflare provider is configured, but the runtime request environment does not include the binding ViteHub expects.

**Fix:** Add the binding named `SANDBOX`, or set `sandbox.binding` to the binding name you already use.

```ts
sandbox: {
  provider: 'cloudflare',
  binding: 'MY_SANDBOX',
}
```

**Verify:** Call the route from a Cloudflare runtime where the binding exists.

## Vercel credentials are missing

**Cause:** Vercel Sandbox needs token, team ID, and project ID. ViteHub could not resolve all three.

**Fix:** Set plain Vercel environment variables:

```bash
VERCEL_TOKEN=<vercel-token>
VERCEL_TEAM_ID=<vercel-team-id>
VERCEL_PROJECT_ID=<vercel-project-id>
```

Or use framework-prefixed variables:

```bash
NITRO_SANDBOX_TOKEN=<vercel-token>
NITRO_SANDBOX_TEAM_ID=<vercel-team-id>
NITRO_SANDBOX_PROJECT_ID=<vercel-project-id>
```

**Verify:** Restart the app or redeploy so the runtime can read the new environment.

## Provider package warning during build

**Cause:** The provider SDK is not installed.

**Fix:** Install the package for the configured provider.

::code-group
```bash [Cloudflare]
pnpm add @cloudflare/sandbox
```

```bash [Vercel]
pnpm add @vercel/sandbox
```
::

**Verify:** Re-run the build. The provider package warning should disappear.

## Invalid `defineSandbox()` options

**Cause:** Definition options use unsupported keys or non-static values. Sandbox supports only `timeout`, `env`, and `runtime` in definition options.

**Fix:** Keep definition options static and JSON-serializable.

```ts
export default defineSandbox(handler, {
  timeout: 30_000,
  env: {
    NODE_ENV: 'production',
  },
})
```

Do not pass dynamic expressions that the build step cannot extract.

**Verify:** Rebuild the app. The definition options error should be gone.

## The route returns a failed sandbox result

**Cause:** The sandbox ran, but provider execution or the handler failed.

**Fix:** Always check `result.isErr()` and return a route error with the normalized message.

```ts
const result = await runSandbox('release-notes', payload)

if (result.isErr()) {
  throw createError({
    statusCode: 500,
    statusMessage: result.error.message,
  })
}

return { result: result.value }
```

**Verify:** Log or inspect `result.error.code`, `result.error.provider`, and `result.error.details` in development.

## The sandbox name is not found

**Cause:** The definition file is outside the discovery path, or the route uses the wrong name.

::fw{id="vite:dev vite:build"}
Vite discovers `src/**/*.sandbox.ts`. `src/release-notes.sandbox.ts` becomes `release-notes`.
::

::fw{id="nitro:dev nitro:build"}
Nitro discovers `server/sandboxes/**`. `server/sandboxes/release-notes.ts` becomes `release-notes`.
::

**Fix:** Move the file into the discovery path or update the `runSandbox()` name.

**Verify:** Rebuild or restart dev mode, then call the route again.

## Related pages

- [Quickstart](./quickstart)
- [Cloudflare](./providers/cloudflare)
- [Vercel](./providers/vercel)
- [Runtime API](./runtime-api)
