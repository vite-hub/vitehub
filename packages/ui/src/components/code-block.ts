import { defineComponent, Fragment, h, type PropType, Text, type VNode } from "vue";
import { slotPart } from "../internal/slot-part.ts";
import { CopyButton } from "./copy-button.ts";

export type CodeBlockVariant = "default" | "destructive";
export type CodeBlockSize = "default" | "sm";
export type CodeBlockLineVariant = "default" | "added" | "removed" | "highlighted";

export const CodeBlock = defineComponent({
  name: "CodeBlock",
  props: {
    size: { default: "default", type: String as PropType<CodeBlockSize> },
    variant: { default: "default", type: String as PropType<CodeBlockVariant> },
  },
  setup(props, { slots }) {
    return () =>
      h("div", { "data-size": props.size, "data-slot": "code-block", "data-variant": props.variant }, slots.default?.());
  },
});

export const CodeBlockHeader = slotPart("CodeBlockHeader", "code-block-header");
export const CodeBlockTitle = slotPart("CodeBlockTitle", "code-block-title");
export const CodeBlockActions = slotPart("CodeBlockActions", "code-block-actions");
export const CodeBlockFooter = slotPart("CodeBlockFooter", "code-block-footer");

/** The copy button of a code block: an extra-small `CopyButton` for the block's actions. */
export const CodeBlockCopyButton = defineComponent({
  name: "CodeBlockCopyButton",
  inheritAttrs: false,
  props: {
    value: { required: true, type: String },
  },
  setup(props, { attrs }) {
    return () => h(CopyButton, { size: "xs", ...attrs, "data-slot": "code-block-copy-button", value: props.value });
  },
});

export const CodeBlockLine = defineComponent({
  name: "CodeBlockLine",
  props: {
    variant: { default: "default", type: String as PropType<CodeBlockLineVariant> },
  },
  setup(props, { slots }) {
    return () => {
      const content = slots.default?.();
      // An empty line holds a newline, so a copied selection keeps its blank lines.
      const empty = !content || content.every(isEmptyText);
      return h("span", { "data-slot": "code-block-line", "data-variant": props.variant }, [
        h("span", { "data-slot": "code-block-line-content" }, empty ? "\n" : content),
      ]);
    };
  },
});

function isEmptyText(node: VNode): boolean {
  return (node.type === Text && String(node.children ?? "") === "") || (typeof node.type === "string" && String(node.children ?? "") === "");
}

function textOf(nodes: VNode[]): string | undefined {
  let text = "";
  for (const node of nodes) {
    if (node.type === Text) text += String(node.children ?? "");
    else if (node.type === Fragment && Array.isArray(node.children)) {
      const inner = textOf(node.children as VNode[]);
      if (inner === undefined) return undefined;
      text += inner;
    } else return undefined;
  }
  return text;
}

export const CodeBlockContent = defineComponent({
  name: "CodeBlockContent",
  props: {
    lineNumbers: { default: false, type: Boolean },
    startLine: { default: 1, type: Number },
    wrap: { default: false, type: Boolean },
  },
  setup(props, { slots }) {
    return () => {
      const children = slots.default?.() ?? [];
      // Plain text is split into lines when the lines are numbered. Highlighted code passes its own `CodeBlockLine` parts.
      const text = props.lineNumbers ? textOf(children) : undefined;
      const lines = text === undefined
        ? children
        : text.replace(/\n$/, "").split("\n").map((line) => h(CodeBlockLine, null, () => line));
      return h(
        "pre",
        {
          // The block clips its content, so the ring of the scrollable code sits inside it.
          "data-focus-inset": "",
          "data-numbered": props.lineNumbers ? "" : undefined,
          "data-slot": "code-block-content",
          "data-wrap": props.wrap ? "" : undefined,
          dir: "ltr",
          style: { counterReset: `line ${props.startLine - 1}` },
          tabindex: 0,
        },
        [h("code", { "data-slot": "code-block-code" }, lines)],
      );
    };
  },
});
