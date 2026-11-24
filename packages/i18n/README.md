# @vite-hub/i18n

`@vite-hub/i18n` translates the text of a Vue app and its server routes. You write each message in your own language, with no message keys. The build turns each message into an ID, keeps one translation record per message in `locales/`, and the server picks the locale of each request. It needs Nitro 3: use Vite with Nitro 3, or Nuxt 5.

Full docs: [vitehub.dev/docs/i18n](https://vitehub.dev/docs/i18n)

## Install

```sh
pnpm add vite-hub @vite-hub/i18n vue
```

## Enable i18n

Set the locales in the ViteHub options. The first locale is the source locale, the language that you write in the code.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: { host: "node", i18n: { locales: ["en", "es"] } },
})
```

In a Vite app, add `vitehub()` after the Vue plugin:

```ts [vite.config.ts]
import vue from "@vitejs/plugin-vue"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vue(),
    vitehub({ host: "node", i18n: { locales: ["en", "es"] } }),
    nitro(),
  ],
})
```

In Nuxt, `vite-hub/nuxt` installs the Vue plugin. In a Vite app, install it before you mount the app:

```ts [src/main.ts]
import { createApp } from "vue"
import { createI18n } from "vite-hub/i18n/vue"
import App from "./App.vue"

createApp(App).use(await createI18n()).mount("#app")
```

## Write messages

Write each message inside ``t`...` ``. Templates need no import:

```vue [src/App.vue]
<template>
  <h1>{{ t`Deploy your agent` }}</h1>
</template>
```

Server code imports `t` and `plural` from `vite-hub/i18n`. `t` reads the locale of the request that runs it:

```ts [server/api/greeting.ts]
import { defineEventHandler } from "h3"
import { plural, t } from "vite-hub/i18n"

export default defineEventHandler(() => ({
  message: t`Payment received`,
  items: plural(2, { one: "# item", other: "# items" }),
}))
```

## Translate

```sh
pnpm vitehub i18n status
pnpm vitehub i18n export es --output es.po
pnpm vitehub i18n import es es.po
```

`status` shows the missing translations of each locale. `export` writes a PO file for a translation tool, and `import` saves its translations to `locales/es/`. Commit the `locales/` folder.

## Public imports

| Import | Purpose |
| --- | --- |
| `@vite-hub/i18n` | `t`, `plural`, `select`, `selectOrdinal`, `msg`, `translate()`, `getLocale()`, `getLocales()`, and `setLocale()` |
| `@vite-hub/i18n/vue` | `createI18n()`, `i18nPlugin()`, and `useLocale()` for Vue apps |
| `@vite-hub/i18n/server` | `useTranslations()`, which saves and publishes translations in a Workspace, and `agentI18n` for the `i18n()` Agent Capability |
| `@vite-hub/i18n/vite` | `hubI18n()`, which `vite-hub` adds for you |

In a ViteHub app, import the same functions from `vite-hub/i18n`, `vite-hub/i18n/vue`, and `vite-hub/i18n/server`.
