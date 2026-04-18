---
title: Sandbox
description: Run named sandbox handlers on Cloudflare Durable Objects or Vercel Sandbox.
navigation.title: Overview
---

Use Sandbox to run one named handler inside an isolated runtime. Define the sandbox once, execute it with `runSandbox()`, and keep provider setup at the application boundary.

::fw{#vite}
- Put sandbox definitions in `src/**/*.sandbox.ts`.
- Default-export `defineSandbox(handler, options?)`.
- Execute the generated name with `runSandbox()`.
::

::fw{#nitro #nuxt}
- Put sandbox definitions in `server/sandboxes/**`.
- Default-export `defineSandbox(handler, options?)`.
- Execute the generated name with `runSandbox()`.
::

## What Sandbox is

Sandbox gives you one portable API for isolated work that still returns a value to the current request. Version 1 supports Cloudflare Durable Object sandboxes and Vercel Sandbox.

## When Sandbox fits

Sandbox is a good fit when you want to:

- run untrusted or isolated code without introducing a queue
- keep filesystem, process, or network isolation explicit
- target Cloudflare or Vercel without changing call sites
- return a result from isolated work inside the same request flow

Use [When to use Sandbox](./when-to-use) when you need to choose between Sandbox, Queue, Workflow, and inline execution.

## What stays portable

These parts stay the same when you switch providers:

- the definition API: `defineSandbox()`
- the execution API: `runSandbox()`
- the sandbox name derived from the file path
- the portable definition options: `timeout`, `env`, and `runtime`

Provider-specific setup, credentials, bindings, and native runtime limits live on the provider pages.

## Where to go next

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Get a first Cloudflare or Vercel sandbox wired into an app.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Look up defineSandbox, runSandbox, and the core Sandbox types.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: When to use Sandbox
  description: Decide when Sandbox is better than Queue, Workflow, or inline execution.
  to: ./when-to-use
  ---
  :::
  :::u-page-card
  ---
  title: Run a sandbox
  description: Execute a named sandbox and handle the returned result safely.
  to: ./guides/run-a-sandbox
  ---
  :::
  :::u-page-card
  ---
  title: Validate payloads
  description: Normalize sandbox input before execution.
  to: ./guides/validate-payloads
  ---
  :::
  :::u-page-card
  ---
  title: Reuse a sandbox
  description: Control sandbox identity with sandboxId when the provider supports reuse.
  to: ./guides/reuse-a-sandbox
  ---
  :::
  :::u-page-card
  ---
  title: Troubleshooting
  description: Diagnose discovery, provider, and runtime result issues.
  to: ./troubleshooting
  ---
  :::
  :::u-page-card
  ---
  title: Runtime playground
  description: Inspect the existing Sandbox playground apps and the files they use.
  to: ./playground
  ---
  :::
::

## Providers

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Cloudflare
  description: Run isolated sandboxes on Durable Objects close to the rest of a Cloudflare stack.
  to: ./providers/cloudflare
  icon: i-simple-icons-cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Use Vercel-hosted isolated execution without changing the public Sandbox API.
  to: ./providers/vercel
  icon: i-simple-icons-vercel
  ---
  :::
::
