---
title: DB troubleshooting
description: Fix common database definition, generation, and hosted output issues.
navigation.title: Troubleshooting
navigation.order: 6
icon: i-lucide-circle-help
frameworks: [vite]
---

## No Database Is Configured

Add a database definition file:

- `server/databases/config.ts`
- `server/databases/<name>/config.ts`
- `src/database.ts`
- `src/<name>.database.ts`

## Default And Named Definitions Are Mixed

Use either one default database or all named databases. Move `server/databases/config.ts` to `server/databases/<name>/config.ts` when adding a second database.

## Drizzle Kit Cannot Find Tables

Run:

```bash
vitehub db generate
```

Then inspect `.vitehub/db/schema/<name>.ts` and `.vitehub/db/drizzle.config.ts`.

## Hosted Output Fails

Cloudflare output needs either D1 metadata or a remote libSQL fallback URL. Vercel output needs a remote libSQL URL for every database.
