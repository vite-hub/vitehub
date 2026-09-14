import type MarkdownIt from "markdown-it";
import type { MarkdownProps } from "@comark/vue";

type ComarkPlugin = NonNullable<MarkdownProps["plugins"]>[number];

/** Parse math before Markdown consumes backslash escapes, without changing code spans or fences. */
export const markdownMath: ComarkPlugin = {
  name: "vitehub-math",
  markdownItPlugins: [(md: MarkdownIt) => {
    md.inline.ruler.before("escape", "vitehub_math_inline", (state, silent) => {
      const start = state.pos;
      const bracket = state.src.startsWith("\\(", start);
      if (!bracket && (state.src[start] !== "$" || state.src[start + 1] === "$")) return false;
      const opening = bracket ? "\\(" : "$";
      const closing = bracket ? "\\)" : "$";
      const contentStart = start + opening.length;
      if (!bracket && /\s/.test(state.src[contentStart] || " ")) return false;
      let end = state.src.indexOf(closing, contentStart);
      while (end !== -1 && state.src[end - 1] === "\\") end = state.src.indexOf(closing, end + closing.length);
      if (end === -1 || end === contentStart) return false;
      const content = state.src.slice(contentStart, end);
      if (content.includes("\n") || content.includes("`")) return false;
      if (!bracket && (/\s/.test(content.at(-1)!) || /\d/.test(state.src[end + 1] || ""))) return false;
      if (!silent) {
        const token = state.push("math_inline", "math", 0);
        token.content = content;
        token.markup = opening;
      }
      state.pos = end + closing.length;
      return true;
    });
    md.block.ruler.before("fence", "vitehub_math_block", (state, startLine, endLine, silent) => {
      const start = state.bMarks[startLine]! + state.tShift[startLine]!;
      const first = state.src.slice(start, state.eMarks[startLine]);
      const opening = first.startsWith("\\[") ? "\\[" : first.startsWith("$$") ? "$$" : undefined;
      if (!opening || state.sCount[startLine]! - state.blkIndent >= 4) return false;
      const closing = opening === "\\[" ? "\\]" : "$$";
      const content: string[] = [];
      for (let line = startLine; line < endLine; line++) {
        const text = line === startLine ? first.slice(opening.length) : state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]);
        const end = text.indexOf(closing);
        if (end !== -1) {
          if (text.slice(end + closing.length).trim()) return false;
          content.push(text.slice(0, end));
          if (silent) return true;
          const token = state.push("math_block", "math", 0);
          token.content = content.join("\n").trim();
          token.block = true;
          token.map = [startLine, line + 1];
          state.line = line + 1;
          return true;
        }
        if (line > startLine && !text.trim()) return false;
        content.push(text);
      }
      return false;
    }, { alt: ["paragraph", "reference", "blockquote", "list"] });
  }],
};
