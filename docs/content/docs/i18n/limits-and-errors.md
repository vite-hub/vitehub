---
title: i18n limits and errors
description: The hosts that i18n supports, what happens to messages that are not in the catalogs, and the fix for each error code.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limits

- **Nitro 3 only.** i18n runs in Vite with Nitro 3 and in Nuxt 5. An unsupported host stops the build with [`I18N_UNSUPPORTED_HOST`](#i18n_unsupported_host).
- **Async context.** ViteHub turns on Nitro's `experimental.asyncContext`, so `t` finds the request that runs it.
- **Translations at build time.** The build reads `locales/<locale>/segments/` when it starts. A translation that you add after the build shows after the next build. In development, a saved record shows after a reload.
- **Messages from files on disk.** The build reads the messages of each module from its file, so a message that another Vite plugin generates is not collected. It still works on the server, but in the browser a production build shows its ID.
- **Build time.** A production build parses each source file that it compiles a second time, to collect the messages.
- **A Workspace needs retained history.** `i18n.workspace` works with the Blob and Database store and the GitHub store. The local store has no `draft` and `published` refs.
- **A Workspace is read every 5 seconds.** Each server instance reads the head of `published` at most once every 5 seconds, so another instance can show the old translations for up to 5 seconds after a publish.
- **The catalog route ignores the app base URL.** The browser reads `/_vitehub/i18n/<locale>.json` from the origin root.
- **`publish()` publishes every changed draft.** It does not pin the drafts that a person reviewed. A save that comes in during a publish can go out with it.
- **Rich-text validation.** `save()` accepts at most 256 distinct numeric tag sequences at each step of expanding ICU branches, in both the source and the translation. Equal tag sequences count once. A message that exceeds this limit returns `I18N_INVALID_TRANSLATION` before any draft is saved. Split it into smaller messages.
- **Memory on the server.** The server loads the compiled messages of every locale when it starts.
- **Locale matching.** A locale matches by its full tag, then by its language. The first configured locale with the same language wins. With `["en", "pt-BR", "pt-PT"]`, a request for `pt` gets `pt-BR`.
- **Top-level messages.** A `t` call at the top level of a module runs before any request and before the page picks a locale. Use [`msg` and `translate()`](/docs/i18n/server-api#msg-and-translate) there.

## Errors

A config error throws when the build starts. A runtime error comes back as `[error, undefined]`. Each error has a `code`, `why`, `fix`, and a `docs` link to its heading on this page.

### I18N_INVALID_LOCALES

`i18n.locales` is empty, has a value that is not a BCP 47 language tag, or lists one tag twice. Tags that differ only in case, such as `"en"` and `"EN"`, count as the same tag. Set `i18n.locales` to a list of tags with the source language first, for example `{ i18n: { locales: ["en", "es"] } }`.

### I18N_UNSUPPORTED_HOST

The app builds the server with an unsupported host. i18n needs Nitro 3, which runs each request in an async context. Use Nuxt 5, or use `vitehub()` with Nitro 3 in a Vite app.

### I18N_MACRO_NOT_COMPILED

`t`, `plural`, `select`, `selectOrdinal`, or `msg` from `vite-hub/i18n` ran without the ViteHub build, so it has no message ID. This happens when `i18n` is not enabled, or when a file that Vite does not build, such as a script that Node.js runs directly, imports the function. Enable `i18n` in `vitehub()` or `vite-hub/nuxt`, and import the function in a file that Vite builds.

### I18N_INVALID_TRANSLATION

`useTranslations().save()` or the `i18n_save_translation` Agent tool got a translation that is not valid ICU MessageFormat, that does not have the same `{placeholders}`, plural arguments, and `<0>` tags as the source text, or whose source or translation exceeds the rich-text validation limit above. Nothing was saved. Fix the translation or split the message and save it again. Plural forms are text, so `one {Artículo}` may differ from `one {Item}`.

### I18N_NO_WORKSPACE

Server code called `useTranslations()`, and `i18n.workspace` is not set. Define a Workspace with retained history, such as `server/workspaces/translations/config.ts`, and set `i18n: { workspace: "translations" }`. Without a Workspace, translations are records in `locales/<locale>/`, and you change them with `vitehub i18n import` or a text editor.

### I18N_UNKNOWN_LOCALE

`setLocale()` got a locale that is not in `i18n.locales`, or `useTranslations()` got the source locale or a locale that is not in `i18n.locales`. Pass one of the configured locales, or add the locale to `i18n.locales`.

```ts
import { setLocale } from "vite-hub/i18n"

const [error] = await setLocale("fr")
if (error?.code === "I18N_UNKNOWN_LOCALE") console.warn(error.fix)
```

### I18N_LOCALE_SUPERSEDED

A newer `setLocale()` call superseded this selection before its catalog loaded. The older call returns `[error, undefined]` without applying its locale. Use the result of the latest call.
