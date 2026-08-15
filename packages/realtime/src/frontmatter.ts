import { Node } from "@tiptap/core"

export const Frontmatter = Node.create({
  name: "frontmatter",
  group: "block",
  atom: true,
  selectable: false,

  addAttributes() {
    return { value: { default: "" } }
  },

  parseHTML() {
    return [{ tag: "pre[data-frontmatter]", getAttrs: element => ({ value: element.textContent || "" }) }]
  },

  renderHTML({ node }) {
    return ["pre", { "data-frontmatter": "", contenteditable: "false" }, node.attrs.value]
  },

  markdownTokenName: "frontmatter",

  markdownTokenizer: {
    name: "frontmatter",
    level: "block",
    start: src => /^---\r?\n(?=[\w-]+:)/.test(src) ? 0 : -1,
    tokenize(src, tokens) {
      if (tokens.length) return
      const match = /^---\r?\n(?=[\w-]+:)([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src)
      if (!match) return
      return { type: "frontmatter", raw: match[0], text: match[1] }
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode("frontmatter", { value: token.text || "" })
  },

  renderMarkdown(node) {
    return `---\n${node.attrs?.value || ""}\n---`
  },
})
