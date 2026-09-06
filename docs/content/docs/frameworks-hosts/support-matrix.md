---
title: Runtime and host support
description: Check which ViteHub contracts exist for each host and how the repository proves them.
navigation.title: Support matrix
navigation.order: 41
icon: i-lucide-table-properties
---

`Package-specific` means support belongs to the named package or generated output, not the host as a whole.

| Contract                  | Local Vite          | Cloudflare           | Vercel               | Netlify                      | Deno                         | Nitro and UnJS               | Node and self-hosted         |
| ------------------------- | ------------------- | -------------------- | -------------------- | ---------------------------- | ---------------------------- | ---------------------------- | ---------------------------- |
| Runtime helpers           | **Available**       | **Package-specific** | **Package-specific** | **Package-specific**         | **Package-specific**         | **Package-specific**         | **Package-specific**         |
| Local providers           | **Available**       | **Package-specific** | **Package-specific** | **Package-specific**         | **Package-specific**         | **Not provided**             | **Local-only**               |
| Generated Provider Output | **Not provided**    | **Package-specific** | **Package-specific** | **Package-specific**         | **Package-specific**         | **Package-specific**         | **Not provided**             |
| Provision support         | **Not provided**    | **Package-specific** | **Package-specific** | **Not provided**             | **Not provided**             | **Not provided**             | **Not provided**             |
| Contract tests            | **Contract-tested** | **Contract-tested**  | **Contract-tested**  | **Contract-tested**          | **Contract-tested**          | **Contract-tested**          | **Contract-tested**          |
| Local Provider Run        | —                   | ✓                    | ✓                    | ✓                            | —                            | —                            | —                            |
| Live Smoke                | —                   | ✓                    | ✓                    | **Live proof not published** | **Live proof not published** | **Live proof not published** | **Live proof not published** |

Cloudflare's nightly run covers nine primitives, including Rate Limit. Vercel covers eight because ViteHub has no native Vercel Rate Limit driver. Browser and Agent routes have contract tests but are outside those deployed runs.

Local memory and filesystem providers stay single-process after deployment. Generated files remain package-owned and must not be imported by application code.
