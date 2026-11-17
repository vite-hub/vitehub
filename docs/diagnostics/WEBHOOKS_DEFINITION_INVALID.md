---
description: "Fix a webhook definition by exporting defineWebhook() and checking its URL variable, secret variable, signature, and debounce options."
---

A file of `server/webhooks/` does not default-export `defineWebhook()`, or an option is wrong. `url` and `secret` must be names of server variables, such as `'T3_WEBHOOK_URL'`, not the URL or the secret. `signature` is `'github'` or `'stripe'`, and `debounce` is a duration such as `'30 minutes'`.
