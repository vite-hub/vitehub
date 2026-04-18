---
title: Sandbox troubleshooting
description: Diagnose common Sandbox setup and runtime problems across Cloudflare and Vercel providers.
navigation.title: Troubleshooting
---

Use this page when Sandbox is wired up but the definition, provider, or returned result is not behaving the way you expect.

## The sandbox name is not found

| Likely cause | Fix |
| --- | --- |
| The sandbox file is not in the discovery directory. | Put the file in `src/**/*.sandbox.ts` for Vite or `server/sandboxes/**` for Nitro and Nuxt. |
| The name in `runSandbox()` does not match the file path. | Check the derived sandbox name and use that exact string. |
| The build output is stale. | Restart the dev server after adding or renaming sandbox files. |

## The sandbox returns an error result

| Likely cause | Fix |
| --- | --- |
| The isolated runtime failed to start or execute. | Check `result.error.message`, `result.error.code`, and the active provider before you wrap the value into your route response. |
| The provider needs extra setup. | Re-read the provider page for bindings, tokens, or runtime limits. |
| The payload shape is wrong. | Validate input before execution with `readValidatedPayload()`. |

## Provider inference does not match production

| Likely cause | Fix |
| --- | --- |
| No provider was inferred outside Cloudflare or Vercel. | Set `sandbox.provider` explicitly. |
| The hosted provider exposes different runtime capabilities. | Check the provider page for file, process, network, or public URL limitations. |
| The examples run against the wrong provider. | Force the examples with `SANDBOX_PROVIDER=cloudflare` or `SANDBOX_PROVIDER=vercel`. |

## Provider-specific setup fails

| Symptom | Fix |
| --- | --- |
| Cloudflare binding or container setup fails. | Check the configured binding name, deployment target, and account access. |
| Vercel sandbox execution fails before the run starts. | Check `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`, or the Nitro/Nuxt alias env vars, when automatic credentials are unavailable. |

## Still stuck

- Re-run the flow with [Quickstart](./quickstart) and an explicit Cloudflare or Vercel provider first.
- Compare your setup with the [Playground](./playground).
- Re-read the provider page for the backend you are using.
