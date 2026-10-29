import { defineComponent, h, type VNode } from "vue"

// Comments are short notes. The overlay renders the part of Markdown they use, as text nodes and elements, never as
// HTML: paragraphs, line breaks, `code`, **bold**, *italic*, [links](https://…), and bare links. The full renderer would
// add the Comark parser, the syntax highlighter, and KaTeX to every page of the app.
const inline = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<>)]+)/g

function safeLink(href: string, label: string): VNode {
  return h("a", { href, rel: "noopener noreferrer", target: "_blank" }, label)
}

export function renderInline(text: string): Array<string | VNode> {
  const nodes: Array<string | VNode> = []
  let last = 0
  for (const match of text.matchAll(inline)) {
    const index = match.index
    if (index > last) nodes.push(text.slice(last, index))
    const token = match[0]
    if (match[1]) nodes.push(h("code", token.slice(1, -1)))
    else if (match[2]) nodes.push(h("strong", token.slice(2, -2)))
    else if (match[3]) nodes.push(h("em", token.slice(1, -1)))
    else if (match[4]) {
      const split = token.indexOf("](")
      nodes.push(safeLink(token.slice(split + 2, -1), token.slice(1, split)))
    }
    else nodes.push(safeLink(token, token))
    last = index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** Stands in for the Markdown part in the overlay bundle. Same `value` prop. */
export const Markdown = defineComponent({
  name: "Markdown",
  inheritAttrs: false,
  props: { value: { default: "", type: String } },
  setup(props, { attrs }) {
    return () =>
      h(
        "div",
        { ...attrs, class: ["vh-markdown", attrs.class] },
        props.value.split(/\n{2,}/).filter(paragraph => paragraph.trim()).map(paragraph =>
          h("p", paragraph.split("\n").flatMap((line, index) => (index ? [h("br"), ...renderInline(line)] : renderInline(line)))),
        ),
      )
  },
})
