---
title: Choose Cloudflare Sandbox or Vercel Sandbox for ViteHub
description: Compare the two built-in ViteHub Sandbox providers by host setup, credentials, isolation, lifecycle, and verification.
navigation.title: Sandbox providers
navigation.order: 22
navigation.group: Server work
icon: i-lucide-box
---

ViteHub supports Cloudflare Sandbox and Vercel Sandbox. The selected provider
owns the execution environment and its isolation. ViteHub owns discovery,
invocation, result handling, and its documented lifecycle behavior.

This comparison describes the built-in integrations checked on 29 October 2026.
It is not a speed or security benchmark.

## Choose by deployment requirements

| Requirement | Cloudflare Sandbox | Vercel Sandbox |
| --- | --- | --- |
| Provider SDK | `@cloudflare/sandbox` | `@vercel/sandbox` |
| Setup | Cloudflare host output, Container, Durable Object binding, and migration. | Vercel project with Sandbox access and runtime credentials. |
| Build check | Inspect generated Worker and Container configuration. | Inspect the selected Sandbox provider and installed SDK. |
| Runtime check | Run a task and inspect its result and provider state. | Run the same task and inspect its result and provider state. |

Choose Cloudflare when your application already runs on Workers and you want
its Container-backed integration. Choose Vercel when the project has Vercel
Sandbox access and that provider fits your execution requirements.

Provider access and limits can change. Check
[Cloudflare Sandbox documentation](https://developers.cloudflare.com/sandbox/)
and [Vercel Sandbox documentation](https://vercel.com/docs/vercel-sandbox)
before choosing a plan.

## Separate the task from its environment

Use [Run a package in a Sandbox](/docs/sandbox/get-started) for a package-backed
task. Keep its package, payload, and expected JSON result the same when you
test another provider. Change the provider configuration and required host
resources, then rebuild.

Changing the provider name alone does not create Cloudflare Container resources
or grant Vercel Sandbox access. The [Sandbox hosts page](/docs/sandbox/hosts)
describes the output required by each provider.

## Verify the boundary you need

Before running untrusted code, check the provider's filesystem, network,
credential, process, and cleanup rules. A typed payload does not restrict
the code's authority inside the provider environment.

Test one successful run, one failure, and one timeout. Check the returned HTTP
status and provider cleanup. If you reuse an environment, test whether files
and processes remain between runs.

ViteHub does not claim that the two providers have identical isolation or
durability. E2B and Daytona are not built-in providers in this comparison.
Use the [Sandbox API](/docs/sandbox/server-api) and
[limits](/docs/sandbox/limits-and-errors) to inspect the selected contract.
