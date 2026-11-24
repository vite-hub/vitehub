import { defineComponent, useSSRContext } from "vue"

import type { DefineComponent, VNodeArrayChildren, VNodeChild } from "vue"

export const emailSubjectContextKey: unique symbol = Symbol.for("vitehub.email.subject")

/** The render context of a Vue Email template. `<EmailSubject>` writes the subject into it. */
export interface EmailVueContext {
  [emailSubjectContextKey]?: string
}

function vnodeText(children: VNodeChild | VNodeArrayChildren): string {
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(child => vnodeText(child)).join("")
  if (!children || typeof children !== "object") return ""
  const content = children.children
  return typeof content === "string" ? content : Array.isArray(content) ? vnodeText(content) : ""
}

/**
 * Sets the subject of a Vue Email template to the text of its slot, such as `<EmailSubject>Join {{ team }}</EmailSubject>`.
 * It renders nothing. A `subject` that the message passes to `email.send()` wins.
 */
export const EmailSubject: DefineComponent = defineComponent({
  name: "EmailSubject",
  setup(_props, { slots }) {
    const context = useSSRContext<EmailVueContext>()
    return () => {
      if (context) context[emailSubjectContextKey] = vnodeText(slots.default?.()).replace(/\s+/g, " ").trim()
      return null
    }
  },
})
