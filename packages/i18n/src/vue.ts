// oxlint-disable-next-line typescript/triple-slash-reference -- Declares the client module that the Vite plugin generates.
/// <reference path="./virtual.d.ts" preserve="true" />
import "virtual:vite-hub/i18n/client"
import { createLingui, Trans } from "@lingui/vue"
import { inject, readonly, shallowRef } from "vue"

import { activateLocale, getI18n, getI18nConfig, getLocales, resolveBrowserLocale, setI18nTracker, setLocale } from "./runtime.ts"

import type { I18n, MessageDescriptor } from "@lingui/core"
import type { App, ComponentCustomProperties, InjectionKey, Plugin, Ref } from "vue"

export interface LocaleState {
  /** The active locale. Templates that read it re-render when it changes. */
  locale: Readonly<Ref<string>>
  /** The configured locales. The first one is the source locale. */
  locales: readonly string[]
  /** Switch to another locale and save the choice in a cookie. */
  setLocale: typeof setLocale
}

const localeKey: InjectionKey<LocaleState> = Symbol("vite-hub.i18n.locale")

// The locale of the last app change. Templates that read it re-render after `setLocale()`.
const activeLocale = shallowRef<string>()

/**
 * Translate a compiled template message. The build calls it for ``t`...` `` in a template when `<script setup>`
 * also imports `t`. Do not call it yourself.
 */
export function translateInTemplate(descriptor: MessageDescriptor): string {
  void activeLocale.value
  return getI18n()._(descriptor)
}

setI18nTracker(() => {
  void activeLocale.value
})

/**
 * Install messages in a Vue app: `t` and `<Trans>` work in every template without an import.
 * Pass `i18n` to use a specific instance, such as the instance of a server request.
 */
export function i18nPlugin(options: { i18n?: I18n } = {}): Plugin {
  return {
    install(app: App) {
      const i18n = options.i18n ?? getI18n()
      const locale = shallowRef(i18n.locale)
      i18n.on("change", () => {
        locale.value = i18n.locale
        activeLocale.value = i18n.locale
      })
      app.use(createLingui({ i18n }))
      app.component("Trans", Trans)
      // Reading `locale` makes each template that calls `t` re-render after a locale change.
      // SAFETY: the build compiles each ``t`...` `` call in a template to `t(descriptor)`, so the runtime receives a descriptor.
      app.config.globalProperties.t = ((descriptor: MessageDescriptor) => {
        void locale.value
        return i18n._(descriptor)
      }) as unknown as ComponentCustomProperties["t"]
      app.provide(localeKey, { locale: readonly(locale), locales: getLocales(), setLocale })
    },
  }
}

/**
 * Pick the browser locale, load its catalog, and return the Vue plugin. Use it in a Vite app:
 * `createApp(App).use(await createI18n()).mount("#app")`. Nuxt apps get it from `vite-hub/nuxt`.
 */
export async function createI18n(): Promise<Plugin> {
  const config = getI18nConfig()
  const i18n = getI18n()
  if (config) await activateLocale(i18n, resolveBrowserLocale(config))
  return i18nPlugin({ i18n })
}

/** The active locale and a way to change it. */
export function useLocale(): LocaleState {
  const state = inject(localeKey, undefined)
  if (state) return state
  return { locale: readonly(shallowRef(getI18n().locale)), locales: getLocales(), setLocale }
}

declare module "vue" {
  interface ComponentCustomProperties {
    /** Translate a message in a template: ``{{ t`Save` }}``. ViteHub compiles it at build time. */
    t: (strings: TemplateStringsArray, ...values: unknown[]) => string
  }
}
