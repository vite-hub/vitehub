# Env

Use Env to declare public, build-time, server runtime, and secret values with typed accessors. Keep secret values out of source and client bundles.

Read the [Env guide](https://vitehub.dev/docs/env), then [Get started](https://vitehub.dev/docs/env/get-started), [Configure](https://vitehub.dev/docs/env/configure), or [Server API](https://vitehub.dev/docs/env/server-api).

Use `#vitehub/env/public` in browser-safe code and `#vitehub/env/server` in server code. Provider-backed Env values are read through the declared provider and do not become public automatically.

Prove missing, valid, and invalid values in the same host mode you will deploy. Inspect declaration metadata, never secret contents.
