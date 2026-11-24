import { htmlToMarkdownText } from "@vite-hub/markdown-template/internal/composition"
import { createSSRApp, h } from "vue"
import { renderToString } from "vue/server-renderer"

import { emailSubjectContextKey } from "../vue.ts"

import type { Component } from "vue"
import type { RenderedEmail } from "../types.ts"
import type { EmailVueContext } from "../vue.ts"

const vueMarkers = /<!--\[-->|<!--\]-->|<!---->|<!--v-if-->/g

export async function renderEmailVue(component: Component, data: Record<string, unknown> = {}): Promise<RenderedEmail> {
  const context: EmailVueContext = {}
  const html = (await renderToString(createSSRApp({ render: () => h(component, data) }), context)).replace(vueMarkers, "")
  const text = await htmlToMarkdownText(html)
  const subject = context[emailSubjectContextKey]
  return subject === undefined ? { html, text } : { subject, html, text }
}
