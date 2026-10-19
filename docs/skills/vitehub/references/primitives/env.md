# Env

<!-- Generated from docs/content/docs/env/index.md. Edit the agent-only block there. -->

Source page: https://vitehub.dev/raw/docs/env.md

Use Env to declare public, build-time, server runtime, and secret values with typed accessors. Keep secret values out of source and client bundles.

Read [Get started](https://vitehub.dev/raw/docs/env/get-started.md), [Configure](https://vitehub.dev/raw/docs/env/configure.md), or [Server API](https://vitehub.dev/raw/docs/env/server-api.md).

Use `#vitehub/env/public` in browser-safe code and `#vitehub/env/server` in server code. Provider-backed Env values are read through the declared provider and do not become public automatically.

Prove missing, valid, and invalid values in the same host mode you will deploy. Inspect declaration metadata, never secret contents.
