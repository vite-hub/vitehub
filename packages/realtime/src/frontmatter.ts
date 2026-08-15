import { Node } from "@tiptap/core"

const frontmatterPattern = /^---\r?\n(?:---(?:\r?\n|$)|([\s\S]*?)\r?\n---(?:\r?\n|$))/

export const Frontmatter = Node.create({
  name: "frontmatter",
  priority: 1_000,
  atom: true,
  selectable: false,

  addAttributes() {
    return { value: { default: null } }
  },

  parseHTML() {
    return [{
      tag: "pre[data-frontmatter]",
      getAttrs: element => ({
        value: element.hasAttribute("data-frontmatter-empty") ? null : element.textContent || "",
      }),
    }]
  },

  renderHTML({ node }) {
    return ["pre", {
      "data-frontmatter": "",
      "data-frontmatter-empty": node.attrs.value === null ? "" : undefined,
      contenteditable: "false",
    }, node.attrs.value ?? ""]
  },

  markdownTokenName: "frontmatter",

  markdownTokenizer: {
    name: "frontmatter",
    level: "block",
    start: src => frontmatterPattern.test(src) ? 0 : -1,
    tokenize(src, tokens) {
      if (tokens.length) return
      const match = frontmatterPattern.exec(src)
      if (!match) return
      return { type: "frontmatter", raw: match[0], text: match[1] }
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode("frontmatter", { value: token.text ?? null })
  },

  renderMarkdown(node) {
    return node.attrs?.value === null ? "---\n---" : `---\n${node.attrs?.value || ""}\n---`
  },
})
