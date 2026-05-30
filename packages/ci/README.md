# @vite-hub/ci

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Providers" src="https://img.shields.io/badge/Providers-GitHub%20%7C%20Vercel%20%7C%20Cloudflare-18181b?style=flat-square">
</p>

`@vite-hub/ci` normalizes deployment and build status across GitHub Actions, Vercel Deployments, and Cloudflare Workers Builds. Use it when ViteHub needs to list runs, inspect one run, fetch logs, or extract the likely failure from provider-specific output.

## Install

```sh
pnpm add @vite-hub/ci
```

## Minimal API

```ts
import { createCIProvider, extractLikelyCIError } from "@vite-hub/ci"

const ci = createCIProvider("github")

const runs = await ci.listRuns({
  token: process.env.GITHUB_TOKEN!,
  owner: "vite-hub",
  repo: "vitehub",
}, {
  branch: "main",
  limit: 10,
})

const logs = await ci.getLogs({
  token: process.env.GITHUB_TOKEN!,
  owner: "vite-hub",
  repo: "vitehub",
}, runs[0]!.id)

const likelyError = extractLikelyCIError(logs.lines, { maxLines: 20 })
```

## Entry points

- `@vite-hub/ci`: provider factory, common types, provider exports, errors, and log helpers.
- `@vite-hub/ci/github`: GitHub Actions provider.
- `@vite-hub/ci/vercel`: Vercel Deployments provider.
- `@vite-hub/ci/cloudflare`: Cloudflare Workers Builds provider.
- `@vite-hub/ci/logs`: CI log error extraction helpers.

Learn more at [vitehub.dev](https://vitehub.dev).
