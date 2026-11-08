import type { ContentHead } from "vite-hub/content"

/** Without a framework, render the tags that useHead() would add. */
export function renderHead(head: ContentHead): string {
  const tag = (entry: Record<string, string | undefined>) => Object.entries(entry).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}="${escape(value!)}"`).join(" ")
  return [
    head.title ? `<title>${escape(head.title)}</title>` : "",
    ...head.meta.map(meta => `<meta ${tag({ ...meta })}>`),
    ...head.link.map(link => `<link ${tag({ ...link })}>`),
    ...(head.script ?? []).map(script => `<script type="${script.type}">${script.innerHTML}</script>`),
  ].join("\n")
}

/** `contentField()` marks the element that renders a Content field. */
export function attributes(record: Record<string, string>): string {
  return Object.entries(record).map(([name, value]) => `${name}="${escape(value)}"`).join(" ")
}

export function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}
