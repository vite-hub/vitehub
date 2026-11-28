---
description: Fix an unknown ViteHub option in Vite or Nuxt by renaming it to a supported option or removing it from the configuration.
---

ViteHub stops the build when `vitehub()` or the Nuxt module options set a top-level key that ViteHub does not recognize. The error names the key. A key whose value is `undefined` does not trigger this error.

## Fix it

- If the error suggests a rename, check that the suggested option enables the feature you want. For example, change `rate-limit` to `rateLimit` to enable Rate Limit.
- If there is no suggestion, remove the key or choose a supported option from the [configuration reference](/docs/reference/config-options). If the key belongs to another plugin, configure it on that plugin instead.
