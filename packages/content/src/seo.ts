import { isStandardSchema, standardIssuePath, standardJsonSchema } from "@vite-hub/internal/standard-schema"
import { withValibotJsonSchema } from "@vite-hub/internal/valibot"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"

import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"

/** Lengths search engines and social cards show before they cut text off. Longer values still validate. */
export const contentSeoLengths = {
  title: { recommended: 60 },
  description: { min: 50, recommended: 160 },
} as const

/** The `x-vitehub-seo` JSON Schema keyword. Forms read it to render an SEO panel with counters and previews. */
export interface ContentSeoHint {
  title: { recommended: number }
  description: { min: number, recommended: number }
}

/** Per-document SEO values. Every key is optional; `contentHead()` falls back to document fields and site defaults. */
export interface ContentSeo<TImage = string> {
  /** Title for search results and social cards. Falls back to the document title. */
  title?: string
  /** Description for search results and social cards. Falls back to the document description or summary. */
  description?: string
  /** Social card image: a URL by default, or a Blob reference with `seo({ image: image() })`. */
  image?: TImage
  /** The canonical URL, absolute or root-relative, when this page duplicates another. Defaults to the document URL. */
  canonical?: string
  /** Ask search engines not to index the page. Sitemaps leave it out. */
  noindex?: boolean
}

export interface ContentSeoOptions<TImage extends StandardSchemaV1 | undefined = undefined> {
  /**
   * Validator of the social image. Defaults to a URL, absolute or root-relative, such as `/og/home.png`. Pass a Blob
   * `image()` to store a Blob reference and get the Console image picker.
   */
  image?: TImage
}

type ImageInput<TImage> = TImage extends StandardSchemaV1 ? StandardSchemaV1.InferInput<TImage> : string
type ImageOutput<TImage> = TImage extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<TImage> : string

/** A `seo()` field: a Standard Schema and Standard JSON Schema for an optional {@link ContentSeo} object. */
export type ContentSeoField<TImage extends StandardSchemaV1 | undefined = undefined> =
  StandardSchemaV1<ContentSeo<ImageInput<TImage>> | undefined, ContentSeo<ImageOutput<TImage>> | undefined> & StandardJSONSchemaV1 & {
    readonly [contentSeoField]: true
  }

const contentSeoField: unique symbol = Symbol.for("vitehub.content.seo")

const urlPattern = /^(?:https?:\/\/[^\s/?#]+[^\s]*|\/(?!\/)[^\s]*)$/i

function isString(value: unknown): value is string {
  return String(value) === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

/** Whether a value is an absolute http(s) URL or a root-relative path. */
export function isContentUrl(value: unknown): value is string {
  return isString(value) && urlPattern.test(value)
}

const defaultImage: StandardSchemaV1<string, string> & StandardJSONSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "vitehub",
    validate: value => isContentUrl(value)
      ? { value }
      : { issues: [{ message: "Image must be an absolute URL or a path that starts with /, such as /og/home.png." }] },
    jsonSchema: {
      input: () => ({ type: "string", format: "uri-reference", description: "Social image URL, absolute or root-relative." }),
      output: () => ({ type: "string", format: "uri-reference", description: "Social image URL, absolute or root-relative." }),
    },
  },
}

const seoKeys: ReadonlySet<string> = new Set(["title", "description", "image", "canonical", "noindex"])

/**
 * A field for per-document SEO: `{ title?, description?, image?, canonical?, noindex? }`. The whole field is optional.
 * Its JSON Schema carries `x-vitehub-seo` with recommended lengths, so the Console renders an SEO panel with counters
 * and search and social previews. Long titles and descriptions still validate; the lengths are guidance.
 *
 * It is a record of validators rather than a Zod or Valibot object, so it can hold an `image()`.
 *
 * @example
 * fields: { title: z.string(), seo: seo({ image: image() }) }
 */
export function seo<TImage extends StandardSchemaV1 | undefined = undefined>(options: ContentSeoOptions<TImage> = {}): ContentSeoField<TImage> {
  if (!isRecord(options)) throw contentErrorDiagnostics.CONTENT_R0006({ message: "[vitehub] seo() options must be an object such as { image: image() }." })
  if (options.image !== undefined && !isStandardSchema(options.image)) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: "[vitehub] seo({ image }) must be a Standard Schema validator, such as image() from vite-hub/content." })
  }
  const image: StandardSchemaV1 = options.image ? withValibotJsonSchema(options.image) : defaultImage

  function validate(value: unknown): StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>> {
    if (value === undefined || value === null) return { value: undefined }
    if (!isRecord(value)) return { issues: [{ message: "SEO must be an object with title, description, image, canonical, or noindex." }] }
    const issues: StandardSchemaV1.Issue[] = []
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      if (!seoKeys.has(key)) issues.push({ message: `Unknown SEO field ${JSON.stringify(key)}. Use title, description, image, canonical, or noindex.`, path: [key] })
    }
    for (const key of ["title", "description"] as const) {
      const text = value[key]
      if (text === undefined || text === "") continue
      if (!isString(text)) issues.push({ message: `SEO ${key} must be text.`, path: [key] })
      else if (text.trim()) output[key] = text
    }
    if (value.canonical !== undefined && value.canonical !== "") {
      if (isContentUrl(value.canonical)) output.canonical = value.canonical
      else issues.push({ message: "Canonical URL must be absolute, such as https://example.com/blog/hello, or start with /.", path: ["canonical"] })
    }
    if (value.noindex !== undefined) {
      if (value.noindex === true || value.noindex === false) {
        if (value.noindex) output.noindex = true
      }
      else issues.push({ message: "SEO noindex must be true or false.", path: ["noindex"] })
    }
    const finish = (imageResult?: StandardSchemaV1.Result<unknown>): StandardSchemaV1.Result<unknown> => {
      if (imageResult?.issues) {
        for (const issue of imageResult.issues) issues.push({ message: issue.message, path: ["image", ...standardIssuePath(issue)] })
      }
      else if (imageResult && imageResult.value !== undefined) output.image = imageResult.value
      return issues.length ? { issues } : { value: output }
    }
    if (value.image === undefined || value.image === null || value.image === "") return finish()
    const result = image["~standard"].validate(value.image)
    return result instanceof Promise ? result.then(finish) : finish(result)
  }

  function jsonSchema(direction: "input" | "output") {
    return (jsonOptions: StandardJSONSchemaV1.Options): Record<string, unknown> => {
      const imageSchema = standardJsonSchema(image, direction, jsonOptions.target, jsonOptions.libraryOptions) ?? {}
      delete imageSchema.$schema
      const hint: ContentSeoHint = {
        title: { ...contentSeoLengths.title },
        description: { ...contentSeoLengths.description },
      }
      return {
        type: "object",
        title: "SEO",
        description: "How search results and social cards show this page.",
        properties: {
          title: { type: "string", description: `Search and social title. Falls back to the document title. Up to about ${hint.title.recommended} characters show in search results.` },
          description: { type: "string", description: `Search and social description. Falls back to the document description or summary. Aim for ${hint.description.min} to ${hint.description.recommended} characters.` },
          image: { ...imageSchema, description: "Social card image, shown at 1.91:1, such as 1200 × 630." },
          canonical: { type: "string", format: "uri-reference", description: "Canonical URL when this page duplicates another. Defaults to the document URL." },
          noindex: { type: "boolean", description: "Ask search engines not to index this page. Sitemaps leave it out." },
        },
        additionalProperties: false,
        "x-vitehub-seo": hint,
      }
    }
  }

  return {
    [contentSeoField]: true,
    "~standard": {
      version: 1,
      vendor: "vitehub",
      // SAFETY: validate() returns ContentSeo values whose image passed the image validator.
      validate: validate as ContentSeoField<TImage>["~standard"]["validate"],
      jsonSchema: { input: jsonSchema("input"), output: jsonSchema("output") },
    },
  }
}

/** Whether a field was created with `seo()`. */
export function isContentSeoField(value: unknown): boolean {
  return isRecord(value) && Reflect.get(value, contentSeoField) === true
}
