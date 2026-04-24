---
title: Sandbox
description: Run isolated code with one portable API on Vite and Nitro.
navigation.title: Overview
icon: i-lucide-terminal-square
frameworks: [vite, nitro]
---

`@vitehub/sandbox` discovers named sandbox definitions from your project, executes them through Cloudflare or Vercel, and returns a normalized result object.

Use Sandbox when code should run in an isolated provider runtime instead of directly inside the request handler.

## What stays portable

These pieces stay stable across Vite and Nitro:

- sandbox definitions with `defineSandbox()`
- execution calls with `runSandbox()`
- safe result handling with `isOk()` and `isErr()`
- typed payloads and return values

## Discovery model

::fw{id="vite:dev vite:build"}
Vite discovers sandboxes from `src/**/*.sandbox.ts`.

The sandbox name comes from the path under `src`, without the `.sandbox` suffix. `src/release-notes.sandbox.ts` becomes `release-notes`.
::

::fw{id="nitro:dev nitro:build"}
Nitro discovers sandboxes from `server/sandboxes/**`.

The sandbox name comes from the path under `server/sandboxes`, without the file extension. `server/sandboxes/release-notes.ts` becomes `release-notes`.
::

## Supported providers

### Cloudflare

Use Cloudflare when sandbox execution should run through Cloudflare's sandbox runtime.

Read [Cloudflare](./providers/cloudflare) for provider setup and configuration.

### Vercel

Use Vercel when sandbox execution should run through Vercel Sandbox.

Read [Vercel](./providers/vercel) for credentials and deployment configuration.

## Start here

Start with [Quickstart](./quickstart) for the smallest setup, then move to [Runtime API](./runtime-api) when you need the exact runtime surface.

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Define a sandbox and run it from a route.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exported functions, helpers, and core types.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Cloudflare
  description: Configure the Cloudflare sandbox provider.
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Configure the Vercel sandbox provider.
  to: ./providers/vercel
  ---
  :::
::
