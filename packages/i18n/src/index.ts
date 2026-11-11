import { i18nErrorDiagnostics } from "./errors.ts"

import type { MessageDescriptor } from "@lingui/core"

export { getLocale, getLocales, setLocale, translate } from "./runtime.ts"
export type { MessageDescriptor } from "@lingui/core"
export type { I18nOptions } from "./locales.ts"

/** A value inside a message: a string, a number, or `{ name: value }` to name the placeholder for translators. */
export type MessageValue = string | number | Readonly<Record<string, string | number>>

/** Forms of `plural()` and `selectOrdinal()`. `#` in a form is the number. */
export interface PluralForms {
  zero?: string
  one?: string
  two?: string
  few?: string
  many?: string
  other: string
  [exact: `${number}`]: string
}

// The ViteHub build replaces each macro call with a message ID, so these bodies run only without the build.
function notCompiled(name: string): never {
  throw i18nErrorDiagnostics.I18N_MACRO_NOT_COMPILED({ name })
}

/**
 * Translate a message in the active locale: ``t`Payment received` `` or ``t`Hello ${name}` ``.
 * Write the message in the source language. `vitehub i18n status` lists the messages that a locale does not translate yet.
 */
export function t(literals: TemplateStringsArray, ...values: MessageValue[]): string
/** Translate a message with a comment or a context for translators: `t({ message: "Save", context: "button" })`. */
export function t(descriptor: { message: string, comment?: string, context?: string }): string
export function t(..._args: unknown[]): string {
  return notCompiled("t")
}

/** Pick the plural form of a number: `plural(count, { one: "# file", other: "# files" })`. */
export function plural(value: number | Readonly<Record<string, number>>, forms: PluralForms): string
export function plural(..._args: unknown[]): string {
  return notCompiled("plural")
}

/** Pick the ordinal form of a number: `selectOrdinal(place, { one: "#st", two: "#nd", few: "#rd", other: "#th" })`. */
export function selectOrdinal(value: number | Readonly<Record<string, number>>, forms: PluralForms): string
export function selectOrdinal(..._args: unknown[]): string {
  return notCompiled("selectOrdinal")
}

/** Pick a form by a value: `select(role, { admin: "Admin", other: "Member" })`. */
export function select(value: string | Readonly<Record<string, string>>, forms: { other: string, [value: string]: string }): string
export function select(..._args: unknown[]): string {
  return notCompiled("select")
}

/**
 * Declare a message without translating it yet, for module-level constants and lists:
 * ``const label = msg`Draft` `` then `translate(label)` where the locale is known.
 */
export function msg(literals: TemplateStringsArray, ...values: MessageValue[]): MessageDescriptor
export function msg(descriptor: { message: string, comment?: string, context?: string }): MessageDescriptor
export function msg(..._args: unknown[]): MessageDescriptor {
  return notCompiled("msg")
}
