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
  const info = rest.slice(match[0].length);
  if (match[2]![0] === "`" && info.includes("`")) return null;
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

function markdownContainer(line: string) {
  const parsed = fenceRun(`${referenceContainer(line)}\`\`\``);
  return {
    listIndent: parsed?.listIndent ?? null,
    quoteDepth: parsed?.quoteDepth ?? 0,
  };
}

function exitsMarkdownContainer(line: string, listIndent: number | null, quoteDepth: number) {
  return leadingQuoteDepth(line) < quoteDepth
    || (listIndent !== null && line.trim() !== "" && indentationOutsideQuotes(line) < listIndent);
}

function splitFrontmatter(source: string): { body: string, frontmatter: Frontmatter } {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith(`${frontmatterBoundary}\n`)) {
    return { body: normalized, frontmatter: {} };
  }

  const closing = normalized.slice(frontmatterBoundary.length + 1).match(/\n---(?:\n|$)/);
  if (!closing || closing.index === undefined) {
    return { body: normalized, frontmatter: {} };
  }
  const end = frontmatterBoundary.length + 1 + closing.index;

  const parsed: unknown = parse(normalized.slice(frontmatterBoundary.length + 1, end));
  const frontmatter: Frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Frontmatter
    : {};

  return {
    body: normalized.slice(end + closing[0].length),
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
    const angleDestination = line[targetStart] === "<";
    let targetEnd = targetStart + (angleDestination ? 1 : 0);
    if (angleDestination) {
      while (targetEnd < line.length && line[targetEnd] !== ">" && line[targetEnd] !== "\n") targetEnd += 1;
      if (line[targetEnd] !== ">") continue;
    } else {
      let parentheses = 0;
      while (targetEnd < line.length) {
        const character = line[targetEnd]!;
        if (character === "(" && !isEscaped(line, targetEnd)) parentheses += 1;
        else if (character === ")" && !isEscaped(line, targetEnd)) {
          if (parentheses === 0) break;
          parentheses -= 1;
        } else if (/\s/.test(character) && parentheses === 0) break;
        targetEnd += 1;
      }
    }
    if (targetEnd === targetStart || !line.includes(")", targetEnd)) continue;

    const destinationStart = targetStart + (angleDestination ? 1 : 0);
    output += line.slice(cursor, destinationStart) + absoluteUrl(line.slice(destinationStart, targetEnd));
    cursor = targetEnd;
    opening = line.indexOf(")", targetEnd);
  }

  return output + line.slice(cursor);
}

function rewriteMarkdownLinks(line: string) {
  return rewriteInlineMarkdownLinks(line);
}

function referenceContainer(line: string) {
  let rest = line;
  let prefix = "";
  while (true) {
    const match = rest.match(/^[ \t]{0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)/);
    if (!match) return prefix;
    prefix += match[0];
    rest = rest.slice(match[0].length);
  }
}

function validReferenceLabel(label: string) {
  let characters = 0;
  for (let index = 0; index < label.length; index += 1) {
    if (label[index] === "\\") index += 1;
    else if (label[index] === "[") return false;
    characters += 1;
  }
  return characters > 0 && characters <= 999;
}

function validReferenceSuffix(suffix: string) {
  if (!suffix) return true;
  const trimmed = suffix.trimStart();
  if (trimmed.length === suffix.length) return false;
  const delimiters: Record<string, string> = { "\"": "\"", "'": "'", "(": ")" };
  const close = delimiters[trimmed[0]!];
  if (!close || trimmed.length < 2 || !trimmed.endsWith(close)) return false;

  for (let index = 1; index < trimmed.length - 1; index += 1) {
    if (trimmed[index] === "\\") {
      if (index + 1 === trimmed.length - 1) return false;
      index += 1;
      continue;
    }
    if (trimmed[index] === close || (trimmed[0] === "(" && trimmed[index] === "(")) return false;
  }
  return true;
}

function parseReferenceDestination(value: string) {
  if (value.startsWith("<")) {
    const end = value.indexOf(">");
    if (end === -1 || value.slice(1, end).includes("<")) return null;
    return { angle: true, destination: value.slice(1, end), suffix: value.slice(end + 1) };
  }

  let depth = 0;
  let end = 0;
  while (end < value.length) {
    const character = value[end]!;
    if (character === "\\") {
      if (end + 1 >= value.length) return null;
      end += 2;
      continue;
    }
    if (/\s/.test(character)) break;
    if (character === "<" || character === ">") return null;
    if (character === "(") {
      depth += 1;
      if (depth > 32) return null;
    } else if (character === ")") {
      if (depth === 0) return null;
      depth -= 1;
    }
    end += 1;
  }
  if (end === 0 || depth !== 0) return null;
  return { angle: false, destination: value.slice(0, end), suffix: value.slice(end) };
}

function rewriteReferenceDefinitions(source: string) {
  const lines = source.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const container = referenceContainer(line);
    const definition = line.slice(container.length).match(/^([ \t]{0,3})\[((?:\\.|[^\\\]])+)\]:([ \t]*)(.*)$/);
    if (!definition) continue;
    if (!validReferenceLabel(definition[2]!)) continue;

    let destinationLine = index;
    let destinationPrefix = `${container}${definition[1]}[${definition[2]}]:${definition[3]}`;
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

    const parsed = parseReferenceDestination(destinationAndTitle);
    if (!parsed?.destination.startsWith("/") || parsed.destination.startsWith("//")) continue;

    if (!validReferenceSuffix(parsed.suffix)) continue;
    lines[destinationLine] = parsed.angle
      ? `${destinationPrefix}<${absoluteUrl(parsed.destination)}>${parsed.suffix}`
      : `${destinationPrefix}${absoluteUrl(parsed.destination)}${parsed.suffix}`;
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

function withoutMarkdownContainers(line: string) {
  const container = referenceContainer(line);
  return line.slice(container.length);
}

function htmlBlockContinues(end: RegExp, openingLine: string) {
  return end.source === "^\\s*$" || !end.test(openingLine);
}

function startsParagraph(line: string) {
  const container = referenceContainer(line);
  if (/(?:^|[ \t])(?:[-+*]|\d{1,9}[.)])[ \t]+/.test(container)) return false;
  const content = line.slice(container.length);
  if (/^[ \t]{0,3}(?:#{1,6}(?:[ \t]+|$)|(?:=+|-+)[ \t]*$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$|(?:-[ \t]*){3,}$)/.test(content)) return false;
  if (/^[ \t]{0,3}\[((?:\\.|[^\\\]])+)\]:/.test(content)) return false;
  if (/^[ \t]*:{2,}/.test(content)) return false;
  return Boolean(content.trim());
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
    const closing = closingPattern.exec(source);
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
  let htmlListIndent: number | null = null;
  let htmlQuoteDepth = 0;
  let listIndent: number | null = null;
  let listQuotePrefix = "";
  let paragraphOpen = false;
  let paragraphQuoteDepth = 0;
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
      if (exitsMarkdownContainer(line, htmlListIndent, htmlQuoteDepth)) {
        htmlEnd = null;
        htmlListIndent = null;
        htmlQuoteDepth = 0;
      } else {
        output.push(lineWithEnding);
        if (htmlEnd.test(withoutMarkdownContainers(line))) {
          htmlEnd = null;
          htmlListIndent = null;
          htmlQuoteDepth = 0;
        }
        continue;
      }
    }

    const htmlLine = withoutMarkdownContainers(line);
    const nextHtmlEnd = rawHtmlBlockEnd(htmlLine);
    const typeSevenHtml = nextHtmlEnd?.source === "^\\s*$"
      && !/^[ \t]{0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t/>]|$)/i.test(htmlLine);
    const quoteDepth = leadingQuoteDepth(referenceContainer(line));
    if (!fence && nextHtmlEnd && !(typeSevenHtml && paragraphOpen && quoteDepth === paragraphQuoteDepth)) {
      output.push(rewriteOutside(), lineWithEnding);
      outsideFence = "";
      if (htmlBlockContinues(nextHtmlEnd, htmlLine)) {
        const htmlContainer = markdownContainer(line);
        htmlEnd = nextHtmlEnd;
        htmlListIndent = htmlContainer.listIndent;
        htmlQuoteDepth = htmlContainer.quoteDepth;
      }
      paragraphOpen = false;
      continue;
    }

    if (!fence && parsedFence) {
      output.push(rewriteOutside(), lineWithEnding);
      outsideFence = "";
      paragraphOpen = false;
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
      paragraphOpen = false;
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
    paragraphOpen = startsParagraph(line);
    paragraphQuoteDepth = quoteDepth;
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
  let htmlListIndent: number | null = null;
  let htmlQuoteDepth = 0;
  const directives: boolean[] = [];

  for (const lineWithEnding of source.match(/.*(?:\n|$)/g) || []) {
    if (!lineWithEnding) continue;
    const line = lineWithEnding.endsWith("\n") ? lineWithEnding.slice(0, -1) : lineWithEnding;
    const structuralDepth = directives.filter(Boolean).length;
    const structuralIndent = Math.min(indentationColumns(line), structuralDepth * 2);
    const deindented = removeIndentation(line, structuralIndent);
    const parsedFence = fenceRun(deindented);

    if (htmlEnd) {
      if (exitsMarkdownContainer(line, htmlListIndent, htmlQuoteDepth)) {
        htmlEnd = null;
        htmlListIndent = null;
        htmlQuoteDepth = 0;
      } else {
        output.push(lineWithEnding);
        if (htmlEnd.test(withoutMarkdownContainers(line))) {
          htmlEnd = null;
          htmlListIndent = null;
          htmlQuoteDepth = 0;
        }
        continue;
      }
    }

    const htmlLine = withoutMarkdownContainers(line);
    const nextHtmlEnd = rawHtmlBlockEnd(htmlLine);
    if (!fence && nextHtmlEnd) {
      output.push(cardList(outsideFence), lineWithEnding);
      outsideFence = "";
      if (htmlBlockContinues(nextHtmlEnd, htmlLine)) {
        const htmlContainer = markdownContainer(line);
        htmlEnd = nextHtmlEnd;
        htmlListIndent = htmlContainer.listIndent;
        htmlQuoteDepth = htmlContainer.quoteDepth;
      }
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
  let htmlListIndent: number | null = null;
  let htmlQuoteDepth = 0;
  for (const originalLine of source.split("\n")) {
    const leadingColumns = indentationColumns(originalLine);
    const structuralDepth = directives.filter(Boolean).length;
    const structuralIndent: number = fence?.indent ?? Math.min(leadingColumns, structuralDepth * 2);
    const deindented = removeIndentation(originalLine, structuralIndent);

    if (htmlEnd) {
      if (exitsMarkdownContainer(deindented, htmlListIndent, htmlQuoteDepth)) {
        htmlEnd = null;
        htmlListIndent = null;
        htmlQuoteDepth = 0;
      } else {
        output.push(deindented);
        if (htmlEnd.test(withoutMarkdownContainers(deindented))) {
          htmlEnd = null;
          htmlListIndent = null;
          htmlQuoteDepth = 0;
        }
        continue;
      }
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

    const htmlLine = withoutMarkdownContainers(deindented);
    const nextHtmlEnd = rawHtmlBlockEnd(htmlLine);
    if (nextHtmlEnd) {
      output.push(deindented);
      if (htmlBlockContinues(nextHtmlEnd, htmlLine)) {
        const htmlContainer = markdownContainer(deindented);
        htmlEnd = nextHtmlEnd;
        htmlListIndent = htmlContainer.listIndent;
        htmlQuoteDepth = htmlContainer.quoteDepth;
      }
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
