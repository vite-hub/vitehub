---
title: ViteHub integration and deployment guides
description: Connect ViteHub to hosted databases, storage and email, deploy an Agent, and choose providers for background work.
navigation.title: Overview
navigation.order: 1
icon: i-lucide-book-open-check
---

Read these after [Installation](/docs/getting-started/installation). Each
solves one deployment or provider task.

## Deploy an Agent

- [Deploy the same Agent on Cloudflare and Vercel](/docs/guides/deploy-agent-cloudflare-vercel).
- [Choose a TypeScript Agent framework](/docs/guides/typescript-agent-frameworks).
- [Compare ViteHub with other tools](/docs/compare).
- [Run the Claude Agent SDK in production](/docs/guides/claude-agent-sdk).
- [Run the Codex SDK in production](/docs/guides/codex-sdk).

## Build a chat bot

- [Build an AI Slack bot](/docs/guides/slack-ai-bot).
- [Build an AI Discord bot](/docs/guides/discord-ai-bot).
- [Build an AI Telegram bot](/docs/guides/telegram-ai-bot).

## Connect a database

- [Use Turso with ViteHub and Drizzle](/docs/guides/turso).
- [Use Neon Postgres](/docs/guides/neon-postgres).
- [Use Cloudflare D1](/docs/guides/cloudflare-d1).

## Store values and files

- [Use Upstash Redis for KV](/docs/guides/upstash-redis).
- [Store files in Cloudflare R2](/docs/guides/cloudflare-r2).
- [Use Vercel Blob](/docs/guides/vercel-blob).

## Run server work

- [Send email with Resend](/docs/guides/resend).
- [Run browser operations on Cloudflare](/docs/guides/cloudflare-browser).
- [Compare AI sandbox providers](/docs/guides/sandbox-providers).
- [Choose Queue, Workflow, or Schedule](/docs/guides/background-jobs).
- [Use Vercel Queues](/docs/guides/vercel-queues).
- [Use Cloudflare Queues](/docs/guides/cloudflare-queues).
- [Use Vercel Cron Jobs](/docs/guides/vercel-cron-jobs).

## Call GitHub, GitLab, or Forgejo

- [Call GitHub as your GitHub App with useForge()](/docs/forge/get-started).

## Add sign-in

- [Run Better Auth on Cloudflare Workers and D1](/docs/guides/better-auth-cloudflare).

## Learn the concepts

- [Rate limiting vs throttling, and the four rate limiting algorithms](/docs/guides/rate-limiting-algorithms).
- [Durable execution: steps, retries, replay, and idempotency](/docs/guides/durable-execution).

Each service sets its own access, prices, quotas, and limits. One API does not
make them the same or move data between services. The
[support matrix](/docs/frameworks-hosts/support-matrix) shows what we tested.
