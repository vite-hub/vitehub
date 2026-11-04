import { defineComponent, h, toRaw, type PropType, type Component, type VNode } from "vue";
import { mentionNamesOf, splitMentions, type MentionName } from "../internal/comment-mentions.ts";

// Comments are short notes. This Markdown renders the part that they use, as text nodes and elements, never as HTML:
// paragraphs, line breaks, `code`, **bold**, *italic*, [links](https://…), bare links, and the mention chips of the
// comment parts. The full renderer would add the Comark parser, the syntax highlighter, and KaTeX to the page.
const inline = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<>)]+)/g;

function safeLink(href: string, label: string): VNode {
  return h("a", { href, rel: "noopener noreferrer", target: "_blank" }, label);
}

function text(value: string, people: readonly MentionName[], chip: Component | undefined): Array<string | VNode> {
  if (!chip || people.length === 0) return [value];
  return splitMentions(value, people).map(part => typeof part === "string" ? part : h(chip, { label: part.name, user: part.id }));
}

export function renderInline(value: string, people: readonly MentionName[] = [], chip?: Component): Array<string | VNode> {
  const nodes: Array<string | VNode> = [];
  let last = 0;
  for (const match of value.matchAll(inline)) {
    const index = match.index;
    if (index > last) nodes.push(...text(value.slice(last, index), people, chip));
    const token = match[0];
    // Code keeps its `@`, as in the full renderer.
    if (match[1]) nodes.push(h("code", token.slice(1, -1)));
    else if (match[2]) nodes.push(h("strong", text(token.slice(2, -2), people, chip)));
    else if (match[3]) nodes.push(h("em", text(token.slice(1, -1), people, chip)));
    else if (match[4]) {
      const split = token.indexOf("](");
      nodes.push(safeLink(token.slice(split + 2, -1), token.slice(1, split)));
    }
    else nodes.push(safeLink(token, token));
    last = index + token.length;
  }
  if (last < value.length) nodes.push(...text(value.slice(last), people, chip));
  return nodes;
}

/** Stands in for the Markdown part. It takes `value`, and the mention plugin and chip that the comment parts pass. */
export const Markdown = defineComponent({
  name: "Markdown",
  inheritAttrs: false,
  props: {
    components: { type: Object as PropType<Record<string, Component>> },
    plugins: { type: Array as PropType<object[]> },
    value: { default: "", type: String },
  },
  setup(props, { attrs }) {
    return () => {
      // A reactive parent may hand over proxies. The plugin's people are kept by the plugin object itself.
      const people = (props.plugins ?? []).flatMap(plugin => mentionNamesOf(toRaw(plugin)) ?? []);
      const chip = props.components?.["comment-mention"];
      return h(
        "div",
        { ...attrs, class: ["vh-markdown", attrs.class] },
        props.value.split(/\n{2,}/).filter(paragraph => paragraph.trim()).map(paragraph =>
          h("p", paragraph.split("\n").flatMap((line, index) => (index ? [h("br"), ...renderInline(line, people, chip)] : renderInline(line, people, chip)))),
        ),
      );
    };
  },
});
