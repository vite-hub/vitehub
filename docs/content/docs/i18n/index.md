---
title: i18n
layout: landing
navigation.title: Overview
description: Write your app in one language with no message keys. ViteHub collects the messages for translators and serves each request in its own locale.
seo.title: Translate Vite and Nuxt apps with ViteHub i18n
navigation.order: 1
icon: i-ph-translate-light
---

::product-hero{tagline="Write the app in your language. No keys. Translators edit one file per locale, and each request gets its own locale."}
  :hero-figure{name="i18n"}
::

::product-files
```vue [src/App.vue]
<script setup lang="ts">
import { useLocale } from 'vite-hub/i18n/vue'

const { locale, setLocale } = useLocale()
</script>

<template>
  <!-- No import and no key: write the English text -->
  <h1>{{ t`Deploy your agent` }}</h1>
  <p><Trans>Read the <a href="/docs">docs</a> first.</Trans></p>
  <button @click="setLocale(locale === 'en' ? 'es' : 'en')">{{ locale }}</button>
</template>
```

```ts [server/api/greeting.ts]
import { defineEventHandler, getQuery } from 'h3'
import { getLocale, plural, t } from 'vite-hub/i18n'

// No event to pass: `t` reads the locale of this request.
export default defineEventHandler((event) => {
  const count = Number(getQuery(event).count ?? 1)
  return {
    locale: getLocale(),
    message: t`Payment received`,
    items: plural(count, { one: '# item', other: '# items' }),
  }
})
```

```json [locales/es/segments/52/5220fa743183ff60.json]
{
  "hash": "5220fa743183ff60",
  "source": "Deploy your agent",
  "text": "Despliega tu agente",
  "origin": "human",
  "review": "edited",
  "derived": "fresh",
  "updatedAt": "2026-11-07T12:00:00.000Z"
}
```
::

::product-features
  :::product-feature-item{title="No keys" icon="i-lucide-text-cursor-input" to="/docs/i18n/configure#write-messages"}
  Write ``t`Save` `` in the source language. `t` and `<Trans>` work in templates with no import.
  :::

  :::product-feature-item{title="One locale for each request" icon="i-lucide-server" to="/docs/i18n/server-api#how-the-server-picks-the-locale"}
  The `locale` cookie, then `Accept-Language`, then the source locale. Server code needs no event.
  :::

  :::product-feature-item{title="IDs in production, not text" icon="i-lucide-hash" to="/docs/i18n/configure#what-the-build-does"}
  The build compiles each message to a short ID and collects the source text. Each locale is a separate chunk that loads when the page needs it.
  :::

  :::product-feature-item{title="One file for each translation" icon="i-lucide-file-text" to="/docs/i18n/configure#translate-the-messages"}
  `locales/` is a [Diglot](https://github.com/danielroe/diglot) translations folder with one record for each message. `vitehub i18n status` shows what is missing, and PO files go in and out.
  :::

  :::product-feature-item{title="Translate an app in one tutorial" icon="i-lucide-rocket" to="/docs/i18n/get-started"}
  A Vue page and a server route in English and Spanish, with no provider account.
  :::

  :::product-feature-item{title="Know the limits" icon="i-lucide-info" to="/docs/i18n/limits-and-errors#limits"}
  Nitro 3 only: Vite with Nitro 3, or Nuxt 5. Each error code has a fix.
  :::
::

::agent-only
Use i18n to translate the text of a Vue app and its server routes. Do not add message keys, and do not add a config file for another i18n library. Write each message in the source language, which is the first entry of `i18n.locales`.

In Vue templates, use ``{{ t`Text` }}`` and `<Trans>` with no import. In scripts and server code, import `t`, `plural`, `select`, `selectOrdinal`, and `msg` from `vite-hub/i18n`. Do not call `t` at the top level of a module. Use `msg` there, and call `translate()` where the code runs.

Check coverage with `pnpm vitehub i18n status --json`. Each translation is a Diglot record in `locales/<locale>/segments/<hh>/<hash>.json`: edit its `text` field only, or use `pnpm vitehub i18n import <locale> <file.po>`. A translation must keep each `{0}` of its message. i18n needs Nitro 3. Use Vite with Nitro 3, or Nuxt 5.
::
