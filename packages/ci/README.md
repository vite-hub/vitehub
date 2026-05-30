# @vite-hub/ci

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Providers" src="https://img.shields.io/badge/Providers-GitHub%20%7C%20Vercel%20%7C%20Cloudflare-18181b?style=flat-square">
</p>

`@vite-hub/ci` normalizes build and deployment status across CI providers.

## Install

```sh
pnpm add @vite-hub/ci
```

## Minimal API

```ts
// scripts/check-ci.ts
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

## Providers

Provider adapters cover [GitHub Actions](https://docs.github.com/en/actions), [Vercel Deployments](https://vercel.com/docs/deployments/overview), and [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).

Learn more at [vitehub.dev](https://vitehub.dev).
