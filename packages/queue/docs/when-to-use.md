---
title: When to use Queue
description: Decide when Queue is the right primitive for background work.
navigation.title: When to use Queue
navigation.order: 4
icon: i-lucide-route
---

Use Queue when a request can return now and the work can happen later.

## Good fits

- send emails, webhooks, or notifications
- retry work that can fail transiently
- delay delivery
- smooth spikes in downstream load
- keep one app-level API while moving between Memory, Cloudflare, and Vercel

## Poor fits

- work that must complete before the response
- multi-step durable workflows with checkpoints
- recurring scheduled tasks
- low-latency in-process work that does not need retry or delivery semantics

## Choose a provider

| Need | Provider |
| --- | --- |
| Local development and tests | Memory |
| Worker-native batch delivery | Cloudflare |
| Vercel deployment-integrated callbacks | Vercel |

Use provider pages for setup details and platform-specific behavior.
