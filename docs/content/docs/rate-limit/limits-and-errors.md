---
title: Rate Limit limits and errors
description: Know the enforcement, identity, and provider limits of Rate Limit.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limitations

- Memory enforcement is local and single-process. It is not a production default for horizontally scaled or request-scoped hosts.
- A production build with unknown hosting must select a provider explicitly or use a direct Rate Limiter.
- Request identity defaults to the H3 event's client address; explicit user or tenant identities remain application policy.
- Managed policies must be static so ViteHub can provision provider infrastructure.
- The package exposes atomic consumption, not a non-consuming check that providers cannot implement consistently.
