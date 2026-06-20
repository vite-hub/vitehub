---
title: llms.txt
description: Expose a compact ViteHub docs index for AI tools and coding agents.
navigation.title: llms.txt
navigation.order: 60
icon: i-lucide-file-text
---

`llms.txt` is the AI-facing index for ViteHub documentation.
It gives AI tools and coding agents a compact way to discover canonical docs pages before reading full Markdown pages.

## Public resources

| Resource | Use |
| --- | --- |
| `/llms.txt` | Start here when you need the public docs map. |
| `/llms-full.txt` | Use when you need the complete public docs set in one file. |
| `/raw/docs/**/*.md` | Read one page as copyable Markdown. |
| `/docs/**` | Read the rendered page when visual structure or navigation matters. |

## Configure the domain

The docs app configures the public domain used in generated AI resource URLs.
Keep the domain stable because agents may cache links from `llms.txt`.

```ts [docs/nuxt.config.ts]
export default defineNuxtConfig({
  llms: {
    domain: 'https://vitehub.dev',
  },
})
```

## What agents should do

AI tools and coding agents should read `llms.txt` first when they need the public docs map.
Then they should fetch the relevant raw Markdown page and keep the URL with any copied context.

```txt [Agent flow]
1. Read /llms.txt.
2. Pick the smallest relevant raw Markdown URL.
3. Read that page before adding local source context.
4. Cite the raw URL or local file path when using the content.
```

## Copy and paste docs context

Use raw Markdown when pasting docs into another AI tool.
Copy the page content together with its source URL so the receiving tool can preserve provenance.

```txt [Prompt context]
Source: https://vitehub.dev/raw/docs/agents/instructions.md

<paste the relevant Markdown section>
```
