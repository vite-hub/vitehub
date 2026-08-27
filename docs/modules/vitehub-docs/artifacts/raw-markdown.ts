const frontmatterBoundary = "---";
const siteOrigin = "https://vitehub.dev";

type Frontmatter = Record<string, string>;

type Fence = {
  length: number;
  marker: string;
  quoteDepth: number;
};

function fenceRun(line: string) {
  let rest = line;
  let quoteDepth = 0;

  while (true) {
    const container = rest.match(/^[ \t]*(?:(>)|(?:[-+*]|\d+[.)])[ \t]+)/);
    if (!container) break;
    if (container[1]) quoteDepth += 1;
    rest = rest.slice(container[0].length);
  }

  const run = rest.match(/^[ \t]*(```+|~~~+)/)?.[1];
  return run ? { quoteDepth, run } : null;
}

function closesFence(line: string, fence: Fence) {
  const parsed = fenceRun(line);
  return parsed?.quoteDepth === fence.quoteDepth
    && parsed.run[0] === fence.marker
    && parsed.run.length >= fence.length;
}

function leadingQuoteDepth(line: string) {
  return (line.match(/^[ \t]*(?:>[ \t]*)+/)?.[0].match(/>/g) || []).length;
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
  return line.replace(/(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/g, (_match, opening: string, target: string, closing: string) => {
    return `${opening}${absoluteUrl(target)}${closing}`;
  });
}

function isEscaped(source: string, index: number) {
  let backslashes = 0;
  while (index > backslashes && source[index - backslashes - 1] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
}

function rewriteInlineLinks(source: string) {
  let output = "";
  let offset = 0;

  for (const opening of source.matchAll(/`+/g)) {
    const openingIndex = opening.index;
    if (openingIndex < offset || isEscaped(source, openingIndex)) continue;

    const marker = opening[0];
    const closingPattern = new RegExp(`(?<!\`)${marker}(?!\`)`, "g");
    closingPattern.lastIndex = openingIndex + marker.length;
    let closing = closingPattern.exec(source);
    while (closing && isEscaped(source, closing.index)) closing = closingPattern.exec(source);
    if (!closing) continue;

    output += rewriteMarkdownLinks(source.slice(offset, openingIndex));
    output += source.slice(openingIndex, closing.index + marker.length);
    offset = closing.index + marker.length;
  }

  return output + rewriteMarkdownLinks(source.slice(offset));
}

function rewriteLinks(source: string) {
  const output: string[] = [];
  let outsideFence = "";
  let fence: Fence | null = null;
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

    if (!fence && parsedFence) {
      output.push(rewriteOutside(), lineWithEnding);
      outsideFence = "";
      fence = {
        length: parsedFence.run.length,
        marker: parsedFence.run[0]!,
        quoteDepth: parsedFence.quoteDepth,
      };
      continue;
    }

    if (fence) {
      if (leadingQuoteDepth(line) < fence.quoteDepth) {
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
  return source.replace(/^::u-page-grid[^\n]*\n([\s\S]*?)^::\s*$/gm, (_grid, cards: string) => {
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
      items.push(`- ${label}${fields.description ? ` — ${fields.description}` : ""}`);
    }
    return items.length > 0 ? `${items.join("\n")}\n` : "";
  });
}

function cardListsOutsideFences(source: string) {
  const output: string[] = [];
  let outsideFence = "";
  let fence: Fence | null = null;

  for (const lineWithEnding of source.match(/.*(?:\n|$)/g) || []) {
    if (!lineWithEnding) continue;
    const line = lineWithEnding.endsWith("\n") ? lineWithEnding.slice(0, -1) : lineWithEnding;
    const parsedFence = fenceRun(line);

    if (!fence && parsedFence) {
      output.push(cardList(outsideFence), lineWithEnding);
      outsideFence = "";
      fence = {
        length: parsedFence.run.length,
        marker: parsedFence.run[0]!,
        quoteDepth: parsedFence.quoteDepth,
      };
      continue;
    }

    if (fence) {
      if (leadingQuoteDepth(line) < fence.quoteDepth) {
        fence = null;
      } else {
        output.push(lineWithEnding);
        if (closesFence(line, fence)) fence = null;
        continue;
      }
    }

    outsideFence += lineWithEnding;
  }

  output.push(cardList(outsideFence));
  return output.join("");
}

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

  for (const originalLine of source.split("\n")) {
    const leadingColumns = indentationColumns(originalLine);
    const structuralDepth = directives.filter(Boolean).length;
    const structuralIndent: number = fence?.indent ?? Math.min(leadingColumns, structuralDepth * 2);
    const deindented = removeIndentation(originalLine, structuralIndent);

    if (fence && leadingQuoteDepth(deindented) < fence.quoteDepth) fence = null;

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
