const frontmatterBoundary = "---";
const siteOrigin = "https://vitehub.dev";

type Frontmatter = Record<string, string>;

type Fence = {
  length: number;
  listIndent: number | null;
  marker: string;
  quoteDepth: number;
};

function fenceRun(line: string) {
  let rest = line;
  let consumed = "";
  let listIndent: number | null = null;
  let quoteDepth = 0;

  while (true) {
    const container = rest.match(/^[ \t]*(?:(>)|(?:[-+*]|\d+[.)])[ \t]+)/);
    if (!container) break;
    if (container[1]) quoteDepth += 1;
    else listIndent = indentationColumns((consumed + container[0]).replace(/[^ \t]/g, " "));
    consumed += container[0];
    rest = rest.slice(container[0].length);
  }

  const match = rest.match(/^([ \t]*)(```+|~~~+)/);
  if (!match || indentationColumns(match[1]!) > 3) return null;
  return match ? {
    listIndent,
    quoteDepth,
    rest: rest.slice(match[0].length),
    run: match[2]!,
  } : null;
}

function closesFence(line: string, fence: Fence) {
  const parsed = fenceRun(line);
  return parsed?.quoteDepth === fence.quoteDepth
    && parsed.run[0] === fence.marker
    && parsed.run.length >= fence.length
    && /^[ \t]*$/.test(parsed.rest);
}

function leadingQuoteDepth(line: string) {
  return (line.match(/^[ \t]*(?:>[ \t]*)+/)?.[0].match(/>/g) || []).length;
}

function indentationOutsideQuotes(line: string) {
  const prefix = line.match(/^(?:[ \t]*>[ \t]?)+/)?.[0] || "";
  return indentationColumns(prefix.replace(/>[ \t]?/g, "") + line.slice(prefix.length));
}

function splitFrontmatter(source: string): { body: string, frontmatter: Frontmatter } {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith(`${frontmatterBoundary}\n`)) {
    return { body: normalized, frontmatter: {} };
  }

  const end = normalized.indexOf(`\n${frontmatterBoundary}\n`, frontmatterBoundary.length + 1);
  if (end === -1) {
    return { body: normalized, frontmatter: {} };
  }

  const frontmatter: Frontmatter = {};
  for (const line of normalized.slice(frontmatterBoundary.length + 1, end).split("\n")) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key = "", rawValue = ""] = match;
    frontmatter[key] = rawValue.trim().replace(/^['"]|['"]$/g, "");
  }

  return {
    body: normalized.slice(end + `\n${frontmatterBoundary}\n`.length),
    frontmatter,
  };
}

function absoluteUrl(value: string) {
  return value.startsWith("/") && !value.startsWith("//") ? `${siteOrigin}${value}` : value;
}

function rewriteMarkdownLinks(line: string) {
  return line.replace(/(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/g, (_match, opening: string, target: string, closing: string, offset: number) => {
    const bracketOffset = offset + (opening.startsWith("!") ? 1 : 0);
    if (isEscaped(line, bracketOffset)) return _match;
    return `${opening}${absoluteUrl(target)}${closing}`;
  });
}

function rawHtmlBlockEnd(line: string) {
  const start = line.match(/^[ \t]{0,3}<(script|pre|style|textarea)(?:[ \t>]|$)/i);
  if (start) return new RegExp(`</${start[1]}>`, "i");
  if (/^[ \t]{0,3}<!--/.test(line)) return /-->/;
  if (/^[ \t]{0,3}<\?/.test(line)) return /\?>/;
  if (/^[ \t]{0,3}<![A-Z]/.test(line)) return />/;
  if (/^[ \t]{0,3}<!\[CDATA\[/.test(line)) return /\]\]>/;
  if (/^[ \t]{0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t/>]|$)/i.test(line)) return /^\s*$/;
  if (/^[ \t]{0,3}(?:<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t\n"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>)[ \t]*$/.test(line)) return /^\s*$/;
  return null;
}

function htmlBlockContinues(end: RegExp, openingLine: string) {
  return end.source === "^\\s*$" || !end.test(openingLine);
}

function isEscaped(source: string, index: number) {
  let backslashes = 0;
  while (index > backslashes && source[index - backslashes - 1] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
}

function rewriteInlineLinks(source: string) {
  let protectedSource = "";
  let offset = 0;
  const codeSpans: string[] = [];
  let placeholderPrefix = "__VITEHUB_RAW_CODE_SPAN_";
  while (source.includes(placeholderPrefix)) placeholderPrefix += "_";

  for (const opening of source.matchAll(/`+/g)) {
    const openingIndex = opening.index;
    if (openingIndex < offset || isEscaped(source, openingIndex)) continue;

    const marker = opening[0];
    const closingPattern = new RegExp(`(?<!\`)${marker}(?!\`)`, "g");
    closingPattern.lastIndex = openingIndex + marker.length;
    let closing = closingPattern.exec(source);
    while (closing && isEscaped(source, closing.index)) closing = closingPattern.exec(source);
    if (!closing) continue;

    protectedSource += source.slice(offset, openingIndex);
    const index = codeSpans.push(source.slice(openingIndex, closing.index + marker.length)) - 1;
    protectedSource += `${placeholderPrefix}${index}__`;
    offset = closing.index + marker.length;
  }

  protectedSource += source.slice(offset);
  return rewriteMarkdownLinks(protectedSource).replace(
    new RegExp(`${placeholderPrefix}(\\d+)__`, "g"),
    (_match, index: string) => codeSpans[Number(index)]!,
  );
}

function rewriteLinks(source: string) {
  const output: string[] = [];
  let outsideFence = "";
  let fence: Fence | null = null;
  let htmlEnd: RegExp | null = null;
  let listIndent: number | null = null;
  let listQuotePrefix = "";
  const protectedLines: string[] = [];
  const rewriteOutside = () => rewriteInlineLinks(outsideFence).replace(
    /\0INDENT(\d+)\0/g,
    (_match, index: string) => protectedLines[Number(index)]!,
  );

  for (const lineWithEnding of source.match(/.*(?:\n|$)/g) || []) {
    if (!lineWithEnding) continue;
    const line = lineWithEnding.endsWith("\n") ? lineWithEnding.slice(0, -1) : lineWithEnding;
    const parsedFence = fenceRun(line);

    if (htmlEnd) {
      output.push(lineWithEnding);
      if (htmlEnd.test(line)) htmlEnd = null;
      continue;
    }

    const nextHtmlEnd = rawHtmlBlockEnd(line);
    if (!fence && nextHtmlEnd) {
      output.push(rewriteOutside(), lineWithEnding);
      outsideFence = "";
      if (htmlBlockContinues(nextHtmlEnd, line)) htmlEnd = nextHtmlEnd;
      continue;
    }

    if (!fence && parsedFence) {
      output.push(rewriteOutside(), lineWithEnding);
      outsideFence = "";
      fence = {
        length: parsedFence.run.length,
        listIndent: parsedFence.listIndent,
        marker: parsedFence.run[0]!,
        quoteDepth: parsedFence.quoteDepth,
      };
      continue;
    }

    if (fence) {
      if (
        leadingQuoteDepth(line) < fence.quoteDepth
        || (fence.listIndent !== null && line.trim() && indentationOutsideQuotes(line) < fence.listIndent)
      ) {
        fence = null;
      } else {
        output.push(lineWithEnding);
        if (closesFence(line, fence)) fence = null;
        continue;
      }
    }

    if (!line.trim()) {
      outsideFence += lineWithEnding;
      output.push(rewriteOutside());
      outsideFence = "";
      continue;
    }

    const quotePrefix = line.match(/^(?:[ \t]*>[ \t]?)+/)?.[0] || "";
    const content = line.slice(quotePrefix.length);
    const contentIndent = indentationColumns(content);
    const listItem = content.match(/^(\s*)(?:[-+*]|\d+[.)])\s+/);
    if (listItem) {
      listIndent = listItem[0].length;
      listQuotePrefix = quotePrefix;
    } else if (
      content.trim()
      && (listIndent === null || quotePrefix !== listQuotePrefix || contentIndent < listIndent)
    ) {
      listIndent = null;
    }

    const codeIndent = listIndent !== null && quotePrefix === listQuotePrefix ? listIndent + 4 : 4;
    if (contentIndent >= codeIndent) {
      const index = protectedLines.push(lineWithEnding) - 1;
      outsideFence += `\0INDENT${index}\0`;
      continue;
    }

    outsideFence += lineWithEnding;
  }

  output.push(rewriteOutside());
  return output.join("");
}

function indentationColumns(line: string) {
  let columns = 0;
  for (const character of line) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

function removeIndentation(line: string, columns: number) {
  let index = 0;
  let removed = 0;

  while (index < line.length && removed < columns) {
    const character = line[index];
    const width = character === " " ? 1 : character === "\t" ? 4 - (removed % 4) : 0;
    if (width === 0 || removed + width > columns) break;
    removed += width;
    index += 1;
  }

  return line.slice(index);
}

function cardList(source: string) {
  return source.replace(/^([ \t]*)::u-page-grid[^\n]*\n([\s\S]*?)^\1::\s*$/gm, (_grid, indent: string, cards: string) => {
    const items: string[] = [];
    const cardPattern = /^\s*:::u-page-card[^\n]*\n\s*---\n([\s\S]*?)\n\s*---\n\s*:::\s*$/gm;
    for (const match of cards.matchAll(cardPattern)) {
      const fields: Frontmatter = {};
      for (const line of (match[1] || "").split("\n")) {
        const field = line.trim().match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
        if (!field) continue;
        fields[field[1] || ""] = (field[2] || "").trim().replace(/^['"]|['"]$/g, "");
      }
      if (!fields.title) continue;
      const label = fields.to ? `[${fields.title}](${absoluteUrl(fields.to)})` : fields.title;
      items.push(`${indent}- ${label}${fields.description ? ` — ${fields.description}` : ""}`);
    }
    return items.length > 0 ? `${items.join("\n")}\n` : "";
  });
}

function cardListsOutsideFences(source: string) {
  const output: string[] = [];
  let outsideFence = "";
  let fence: Fence | null = null;
  let htmlEnd: RegExp | null = null;
  const directives: boolean[] = [];

  for (const lineWithEnding of source.match(/.*(?:\n|$)/g) || []) {
    if (!lineWithEnding) continue;
    const line = lineWithEnding.endsWith("\n") ? lineWithEnding.slice(0, -1) : lineWithEnding;
    const structuralDepth = directives.filter(Boolean).length;
    const structuralIndent = Math.min(indentationColumns(line), structuralDepth * 2);
    const deindented = removeIndentation(line, structuralIndent);
    const parsedFence = fenceRun(deindented);

    if (htmlEnd) {
      output.push(lineWithEnding);
      if (htmlEnd.test(line)) htmlEnd = null;
      continue;
    }

    const nextHtmlEnd = rawHtmlBlockEnd(line);
    if (!fence && nextHtmlEnd) {
      output.push(cardList(outsideFence), lineWithEnding);
      outsideFence = "";
      if (htmlBlockContinues(nextHtmlEnd, line)) htmlEnd = nextHtmlEnd;
      continue;
    }

    if (!fence && parsedFence) {
      output.push(cardList(outsideFence), lineWithEnding);
      outsideFence = "";
      fence = {
        length: parsedFence.run.length,
        listIndent: parsedFence.listIndent,
        marker: parsedFence.run[0]!,
        quoteDepth: parsedFence.quoteDepth,
      };
      continue;
    }

    if (fence) {
      if (
        leadingQuoteDepth(deindented) < fence.quoteDepth
        || (fence.listIndent !== null && deindented.trim() && indentationOutsideQuotes(deindented) < fence.listIndent)
      ) {
        fence = null;
      } else {
        output.push(lineWithEnding);
        if (closesFence(deindented, fence)) fence = null;
        continue;
      }
    }

    outsideFence += lineWithEnding;

    if (/^\s*:{2,}\s*$/.test(deindented)) {
      directives.pop();
      continue;
    }

    const directive = deindented.match(/^\s*:{2,}([a-z][a-z0-9-]*)(?:\{[^}]*\})?\s*$/i);
    if (directive) directives.push(presentationDirectives.has((directive[1] || "").toLowerCase()));
  }

  output.push(cardList(outsideFence));
  return output.join("");
}

const presentationDirectives = new Set([
  "component-preview",
  "important",
  "note",
  "steps",
  "tabs",
  "tabs-item",
  "tip",
  "u-page-card",
  "u-page-grid",
  "warning",
]);

function directiveLabel(name: string, attributes: string | undefined) {
  if (["note", "tip", "warning", "important"].includes(name)) {
    return `> **${name[0]!.toUpperCase()}${name.slice(1)}**`;
  }

  if (name === "tabs-item") {
    const label = attributes?.match(/\blabel=(?:"([^"]+)"|'([^']+)')/)?.slice(1).find(Boolean);
    return label ? `### ${label}` : "";
  }

  if (name === "component-preview") {
    return "_Interactive preview available on the rendered documentation page._";
  }

  return "";
}

function stripPresentationDirectives(source: string) {
  const output: string[] = [];
  const directives: boolean[] = [];
  let fence: (Fence & { indent: number }) | null = null;
  let htmlEnd: RegExp | null = null;
  for (const originalLine of source.split("\n")) {
    const leadingColumns = indentationColumns(originalLine);
    const structuralDepth = directives.filter(Boolean).length;
    const structuralIndent: number = fence?.indent ?? Math.min(leadingColumns, structuralDepth * 2);
    const deindented = removeIndentation(originalLine, structuralIndent);

    if (htmlEnd) {
      output.push(deindented);
      if (htmlEnd.test(deindented)) htmlEnd = null;
      continue;
    }

    if (
      fence
      && (
        leadingQuoteDepth(deindented) < fence.quoteDepth
        || (fence.listIndent !== null && deindented.trim() && indentationOutsideQuotes(deindented) < fence.listIndent)
      )
    ) fence = null;

    if (!fence && leadingColumns >= structuralDepth * 2 + 4) {
      output.push(deindented);
      continue;
    }

    const parsedFence = fenceRun(deindented);
    if (parsedFence) {
      if (!fence) {
        fence = {
          indent: structuralIndent,
          length: parsedFence.run.length,
          listIndent: parsedFence.listIndent,
          marker: parsedFence.run[0]!,
          quoteDepth: parsedFence.quoteDepth,
        };
      }
      else if (closesFence(deindented, fence)) fence = null;
      output.push(deindented);
      continue;
    }

    if (fence) {
      output.push(deindented);
      continue;
    }

    const nextHtmlEnd = rawHtmlBlockEnd(deindented);
    if (nextHtmlEnd) {
      output.push(deindented);
      if (htmlBlockContinues(nextHtmlEnd, deindented)) htmlEnd = nextHtmlEnd;
      continue;
    }

    if (/^\s*:{2,}\s*$/.test(deindented)) {
      const stripped = directives.pop();
      if (stripped === false || stripped === undefined) output.push(deindented);
      continue;
    }

    const directive = deindented.match(/^\s*:{2,}([a-z][a-z0-9-]*)(?:\{([^}]*)\})?\s*$/i);
    if (directive) {
      const name = (directive[1] || "").toLowerCase();
      const stripped = presentationDirectives.has(name);
      directives.push(stripped);
      if (!stripped) {
        output.push(deindented);
        continue;
      }
      const label = directiveLabel(name, directive[2]);
      if (label) output.push(label, "");
      continue;
    }

    output.push(deindented);
  }

  return rewriteLinks(output.join("\n"));
}

export function toRawMarkdown(source: string) {
  const { body, frontmatter } = splitFrontmatter(source);
  const title = frontmatter.title;
  const content = stripPresentationDirectives(cardListsOutsideFences(body)).replace(/^\n+|\n+$/g, "");
  const document = title && !content.startsWith("# ") ? `# ${title}\n\n${content}` : content;
  return `${document}\n`;
}
