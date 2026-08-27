import { parse } from "yaml";

const frontmatterBoundary = "---";
const siteOrigin = "https://vitehub.dev";

type Frontmatter = Record<string, unknown>;
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
  return parsed?.listIndent === null
    && parsed.quoteDepth === fence.quoteDepth
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

  const parsed: unknown = parse(normalized.slice(frontmatterBoundary.length + 1, end));
  const frontmatter: Frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Frontmatter
    : {};

  return {
    body: normalized.slice(end + `\n${frontmatterBoundary}\n`.length),
    frontmatter,
  };
}

function absoluteUrl(value: string) {
  return value.startsWith("/") && !value.startsWith("//") ? `${siteOrigin}${value}` : value;
}

function rewriteInlineMarkdownLinks(line: string) {
  let cursor = 0;
  let output = "";

  for (let opening = 0; opening < line.length; opening += 1) {
    if (line[opening] !== "[" || isEscaped(line, opening)) continue;

    let depth = 1;
    let closing = opening + 1;
    for (; closing < line.length && depth > 0; closing += 1) {
      if (isEscaped(line, closing)) continue;
      if (line[closing] === "[") depth += 1;
      else if (line[closing] === "]") depth -= 1;
    }
    if (depth !== 0 || line[closing] !== "(") continue;

    const targetStart = closing + 1;
    let targetEnd = targetStart;
    while (targetEnd < line.length && !/[\s)]/.test(line[targetEnd]!)) targetEnd += 1;
    if (targetEnd === targetStart || !line.includes(")", targetEnd)) continue;

    output += line.slice(cursor, targetStart) + absoluteUrl(line.slice(targetStart, targetEnd));
    cursor = targetEnd;
    opening = line.indexOf(")", targetEnd);
  }

  return output + line.slice(cursor);
}

function rewriteMarkdownLinks(line: string) {
  return rewriteInlineMarkdownLinks(line);
}

function referenceContainer(line: string) {
  const match = line.match(/^(?:(?:[ \t]{0,3}>[ \t]?)+)?(?:[ \t]{0,3}(?:[-+*]|\d+[.)])[ \t]+)?/);
  return match?.[0] || "";
}

function rewriteReferenceDefinitions(source: string) {
  const lines = source.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const container = referenceContainer(line);
    const definition = line.slice(container.length).match(/^([ \t]{0,3})(\[(?:\\.|[^\\\]])+\]:)([ \t]*)(.*)$/);
    if (!definition) continue;

    let destinationLine = index;
    let destinationPrefix = `${container}${definition[1]}${definition[2]}${definition[3]}`;
    let destinationAndTitle = definition[4]!;

    if (!destinationAndTitle) {
      const next = lines[index + 1];
      if (next === undefined) continue;
      const nextContainer = referenceContainer(next);
      if (leadingQuoteDepth(nextContainer) !== leadingQuoteDepth(container)) continue;
      const continuation = next.slice(nextContainer.length).match(/^([ \t]{1,3})(\S.*)$/);
      if (!continuation) continue;
      destinationLine = index + 1;
      destinationPrefix = `${nextContainer}${continuation[1]}`;
      destinationAndTitle = continuation[2]!;
    }

    const angleDestination = destinationAndTitle.match(/^<([^<>\n]*)>([ \t]*(?:["'(].*)?)$/);
    const bareDestination = destinationAndTitle.match(/^([^\s<>]+)([ \t]*(?:["'(].*)?)$/);
    const destination = angleDestination?.[1] ?? bareDestination?.[1];
    if (!destination?.startsWith("/") || destination.startsWith("//")) continue;

    const suffix = (angleDestination ?? bareDestination)![2]!;
    lines[destinationLine] = angleDestination
      ? `${destinationPrefix}<${absoluteUrl(destination)}>${suffix}`
      : `${destinationPrefix}${absoluteUrl(destination)}${suffix}`;
  }

  return lines.join("\n");
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

function withoutBlockquoteContainers(line: string) {
  return line.replace(/^(?:[ \t]{0,3}>[ \t]?)+/, "");
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
  const rewriteOutside = () => rewriteReferenceDefinitions(rewriteInlineLinks(outsideFence)).replace(
    /\0INDENT(\d+)\0/g,
    (_match, index: string) => protectedLines[Number(index)]!,
  );

  for (const lineWithEnding of source.match(/.*(?:\n|$)/g) || []) {
    if (!lineWithEnding) continue;
    const line = lineWithEnding.endsWith("\n") ? lineWithEnding.slice(0, -1) : lineWithEnding;
    const parsedFence = fenceRun(line);

    if (htmlEnd) {
      output.push(lineWithEnding);
      if (htmlEnd.test(withoutBlockquoteContainers(line))) htmlEnd = null;
      continue;
    }

    const htmlLine = withoutBlockquoteContainers(line);
    const nextHtmlEnd = rawHtmlBlockEnd(htmlLine);
    if (!fence && nextHtmlEnd) {
      output.push(rewriteOutside(), lineWithEnding);
      outsideFence = "";
      if (htmlBlockContinues(nextHtmlEnd, htmlLine)) htmlEnd = nextHtmlEnd;
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
      const index = protectedLines.push(line) - 1;
      outsideFence += `\0INDENT${index}\0${lineWithEnding.endsWith("\n") ? "\n" : ""}`;
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
      const parsed: unknown = parse(match[1] || "");
      const fields = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
      const title = typeof fields.title === "string" ? fields.title.trim() : null;
      const to = typeof fields.to === "string" ? fields.to.trim() : null;
      const description = typeof fields.description === "string" ? fields.description.trim() : null;
      if (!title) continue;
      const label = to ? `[${title}](${absoluteUrl(to)})` : title;
      items.push(`${indent}- ${label}${description ? ` — ${description}` : ""}`);
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
      if (htmlEnd.test(withoutBlockquoteContainers(line))) htmlEnd = null;
      continue;
    }

    const htmlLine = withoutBlockquoteContainers(line);
    const nextHtmlEnd = rawHtmlBlockEnd(htmlLine);
    if (!fence && nextHtmlEnd) {
      output.push(cardList(outsideFence), lineWithEnding);
      outsideFence = "";
      if (htmlBlockContinues(nextHtmlEnd, htmlLine)) htmlEnd = nextHtmlEnd;
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
      if (htmlEnd.test(withoutBlockquoteContainers(deindented))) htmlEnd = null;
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

    const htmlLine = withoutBlockquoteContainers(deindented);
    const nextHtmlEnd = rawHtmlBlockEnd(htmlLine);
    if (nextHtmlEnd) {
      output.push(deindented);
      if (htmlBlockContinues(nextHtmlEnd, htmlLine)) htmlEnd = nextHtmlEnd;
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
  const title = typeof frontmatter.title === "string" ? frontmatter.title.trim() : undefined;
  const content = stripPresentationDirectives(cardListsOutsideFences(body)).replace(/^\n+|\n+$/g, "");
  const document = title && !content.startsWith("# ") ? `# ${title}\n\n${content}` : content;
  return `${document}\n`;
}
