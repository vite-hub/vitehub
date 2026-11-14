import { checkForm, formFields } from "@vite-hub/forms"

import { isRecord } from "./define.ts"
import { notAForm } from "./diagnostics.ts"
import { viteHubCatalog } from "./entries.ts"

import type { FormField, FormSource, FormSubmitError } from "@vite-hub/forms"
import type { Catalog } from "./define.ts"
import type { CatalogSpec } from "./validate.ts"

export interface SpecFormOptions {
  /** The catalog that the spec was checked with. The built-in catalog by default. */
  catalog?: Catalog
}

/** The form of `@vite-hub/forms` that the Form element `id` of `spec` names. Throws `AGENT_UI_C0004` for any other element. */
export function specForm(spec: CatalogSpec, id: string, options: SpecFormOptions = {}): FormSource {
  const catalog = options.catalog ?? viteHubCatalog
  const element = Object.hasOwn(spec.elements, id) ? spec.elements[id] : undefined
  if (!element) throw notAForm(id, "the spec has no such element.")
  if (element.type !== "Form") throw notAForm(id, `it is a ${element.type}.`)
  const name = isRecord(element.props) ? element.props.form : undefined
  if (typeof name !== "string" || !Object.hasOwn(catalog.forms, name)) throw notAForm(id, `the catalog has no form ${JSON.stringify(name)}.`)
  return catalog.forms[name]!
}

/** The fields that a renderer draws for the Form element `id`, from `formFields()` of `@vite-hub/forms`. */
export function specFormFields(spec: CatalogSpec, id: string, options: SpecFormOptions = {}): FormField[] {
  return formFields(specForm(spec, id, options))
}

/**
 * Checks the values that the Form element `id` sent with the schema of its form: `checkForm()` of `@vite-hub/forms`,
 * the same check as the form route, an MCP elicitation, and a chat modal. Returns `[undefined, data]`, or `[error]` with
 * the issue of each field.
 *
 * @example
 * ```ts
 * // The Agent gets { name: "invite.send", context: { values } } from the Form's on.submit.
 * const [error, invite] = await checkSpecForm(spec, "invite", context.values, { catalog })
 * if (error) return fieldErrors(error)
 * ```
 */
export function checkSpecForm(spec: CatalogSpec, id: string, values: unknown, options: SpecFormOptions = {}): Promise<[FormSubmitError, undefined] | [undefined, unknown]> {
  return checkForm(specForm(spec, id, options), values)
}

