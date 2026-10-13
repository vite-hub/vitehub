---
title: Rate Limit hosts
description: Inspect the generated Rate Limit manifest and deploy managed Rate Limits to Cloudflare.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Inspect generated guarantees

The integration writes `.vitehub/rate-limit/manifest.json` during configuration and Provider Output. Agents and tooling can inspect it. Application code keeps using the guard.

The manifest records `enforcement`, counter `scope`, `rejectedAttempts`, and supported `windows` without duplicating optional response metadata contracts.

```json [.vitehub/rate-limit/manifest.json]
{
  "schemaVersion": 2,
  "rateLimits": [
    {
      "name": "image-upload",
      "provider": "cloudflare",
      "capabilities": {
        "enforcement": "best-effort",
        "rejectedAttempts": "unknown",
        "scope": "location",
        "windows": [10000, 60000]
      }
    }
  ]
}
```

## Deploy to Cloudflare

With a Cloudflare Nitro preset, `hubRateLimit()` infers the provider. Set a deployment-unique namespace so matching Rate Limit IDs cannot share counters across Workers or environments in the same Cloudflare account.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubRateLimit({ namespace: 'acme-image-service-production' })],
})
```

`vitehub({ preset: 'cloudflare', rateLimit: true })` sets the namespace to the deployment name and ignores a configured `rateLimit.namespace`. The deployment name comes from `vitehub({ name })`, `WRANGLER_CI_OVERRIDE_NAME`, the `package.json` name, or the project directory, in that order.

Cloudflare native enforcement is best-effort and exposes only 10-second and 60-second windows. It does not return portable quota metadata, so incompatible policies fail during the build. Use a different namespace for staging, production, and any separately deployed Worker because Cloudflare shares counters with the same namespace ID across Workers.

Inspect generated `wrangler.json` entries and exercise the deployed Worker. A request-scoped Cloudflare binding cannot be validated from an unrelated Node script.
