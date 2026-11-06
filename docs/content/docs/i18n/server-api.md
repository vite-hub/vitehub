---
title: i18n server API
description: Translate messages in server routes, read and change the locale, and translate messages that you declare with msg.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-server
---

Import the API from `vite-hub/i18n`. The same functions run in server routes, in Vue components, and in browser code. On the server they read the locale of the current request.

```ts
import { getLocale, getLocales, msg, plural, select, selectOrdinal, setLocale, t, translate } from "vite-hub/i18n"
```

`t`, `plural`, `select`, `selectOrdinal`, and `msg` are compiled by the build. They work only in files that Vite builds with `i18n` enabled. Without the build, they throw [`I18N_MACRO_NOT_COMPILED`](/docs/i18n/limits-and-errors#i18n_macro_not_compiled).

## How the server picks the locale

Each request gets its own locale. The server takes the first match of:

1. The `locale` cookie, which `setLocale()` writes in the browser. Change the name with the `cookie` option.
2. The `Accept-Language` header, best quality first.
3. The source locale.

A tag matches a configured locale with the same tag first, then with the same language. With `locales: ["en", "es", "pt-BR"]`, `es-MX` gets `es`, and `pt-PT` gets `pt-BR`. A tag with no match, such as `fr`, goes to the next step.

## Translate in a route

Call `t` in a route. You do not pass the event. Nitro 3 runs each request in an async context, and `t` reads the locale of the request that runs it. Code that a route calls, such as a function in `server/utils/`, also gets the locale of that request.

```ts [server/api/receipt.ts]
import { defineEventHandler } from "h3"
import { getLocale, plural, t } from "vite-hub/i18n"

export default defineEventHandler(() => {
  const items = 3
  return {
    locale: getLocale(),
    title: t`Payment received`,
    summary: plural(items, { one: "# item", other: "# items" }),
  }
})
```

Concurrent requests in different locales do not share a locale. ViteHub turns on Nitro's `experimental.asyncContext` for this.

## t

```ts
t`Payment received`
t`Hello ${name}`
t({ message: "Open", context: "button", comment: "Opens the file" })
```

Returns the message in the active locale. A message without a translation returns the source text. A value inside the template becomes a placeholder. Pass `{ name: value }` to give the placeholder a name for translators: ``t`Hello ${{ name: user.name }}` ``.

| Field | Meaning |
| --- | --- |
| `message` | The text in the source language. |
| `comment` | A note for translators. It shows in the catalog. |
| `context` | Keeps two equal texts apart. "Open" with `context: "button"` and "Open" with `context: "status"` are two messages. |

## plural, selectOrdinal, and select

```ts
plural(count, { one: "# file", other: "# files" })
selectOrdinal(place, { one: "#st", two: "#nd", few: "#rd", other: "#th" })
select(role, { admin: "Admin", other: "Member" })
```

`plural()` and `selectOrdinal()` take the forms `zero`, `one`, `two`, `few`, `many`, and `other`, and exact numbers such as `"0"`. `other` is required. `#` in a form is the number. Translators write the forms of their own language in the catalog.

`select()` takes one form for each value, and `other` for every other value.

## msg and translate

```ts
const label = msg`Draft`
translate(label)
```

`msg` declares a message and returns a `MessageDescriptor`. It does not translate. `translate(descriptor)` translates it in the active locale. Use them for a message at the top level of a module, where no request exists yet:

```ts [server/utils/statuses.ts]
import { msg, translate } from "vite-hub/i18n"

const labels = { draft: msg`Draft`, live: msg`Live` }

export function statusLabel(status: keyof typeof labels) {
  return translate(labels[status])
}
```

A `t` call at the top level of a module runs once, before any request. It does not get the locale of a request.

## getLocale and getLocales

```ts
getLocale() // "es"
getLocales() // ["en", "es", "pt-BR"]
```

`getLocale()` returns the active locale. On the server, it is the locale of the current request. `getLocales()` returns the configured locales. The first one is the source locale.

## setLocale

```ts
const [error, locale] = await setLocale("es")
if (error) console.error(error.code, error.fix)
```

`setLocale()` returns `[error, locale]` and does not throw. On success, `locale` is the configured tag. It matches the tag with no regard to case, so `"ES"` returns `"es"`. In the browser, it also:

- loads the catalog of the locale and re-renders the messages,
- sets `<html lang>`,
- saves the locale in the `locale` cookie for one year, so the next server request uses it.

For a locale that is not in `i18n.locales`, `error.code` is [`I18N_UNKNOWN_LOCALE`](/docs/i18n/limits-and-errors#i18n_unknown_locale) and `locale` is `undefined`.

On the server, `setLocale()` switches only the current request, for example to answer in the locale of a user profile. It does not write a cookie. To save the choice of a person from a server route, set the `locale` cookie in the response.

## Vue

Import the Vue API from `vite-hub/i18n/vue`. Nuxt 5 apps get the plugin from `vite-hub/nuxt` and `useLocale()` as an auto-import.

| Export | Meaning |
| --- | --- |
| `createI18n()` | Picks the browser locale, loads its catalog, and returns the Vue plugin: `createApp(App).use(await createI18n())`. |
| `useLocale()` | Returns `{ locale, locales, setLocale }`. `locale` is a read-only ref. Templates that read it re-render when it changes. |
| `t` in templates | ``{{ t`Save` }}`` and `:placeholder="t`Search`"`, with no import. |
| `<Trans>` | A message with markup: `<Trans>Read the <a href="/docs">docs</a>.</Trans>`. The component is global, with no import. |

## Types

| Type | Meaning |
| --- | --- |
| `I18nOptions` | The `i18n` option: `{ locales, cookie? }`. |
| `MessageDescriptor` | What `msg` returns and `translate()` takes. |
| `MessageValue` | A value in a message: a string, a number, or `{ name: value }`. |
| `PluralForms` | The forms of `plural()` and `selectOrdinal()`. |
