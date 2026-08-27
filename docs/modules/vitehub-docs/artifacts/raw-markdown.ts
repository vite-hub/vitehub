const frontmatterBoundary = "---";
const siteOrigin = "https://vitehub.dev";

type Frontmatter = Record<string, string>;

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

function rewriteLinks(line: string) {
  return line.replace(/(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/g, (_match, opening: string, target: string, closing: string) => {
    return `${opening}${absoluteUrl(target)}${closing}`;
  });
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
  let fence: { length: number, marker: string } | null = null;

  for (const lineWithEnding of source.match(/.*(?:\n|$)/g) || []) {
    if (!lineWithEnding) continue;
    const line = lineWithEnding.endsWith("\n") ? lineWithEnding.slice(0, -1) : lineWithEnding;
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);

    if (!fence && fenceMatch) {
      output.push(cardList(outsideFence), lineWithEnding);
      outsideFence = "";
      fence = { length: fenceMatch[1]!.length, marker: fenceMatch[1]![0]! };
      continue;
    }

    if (fence) {
      output.push(lineWithEnding);
      if (fenceMatch?.[1]?.[0] === fence.marker && fenceMatch[1].length >= fence.length) fence = null;
      continue;
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
  let depth = 0;
  let fence: { indent: number, length: number, marker: string } | null = null;

  for (const originalLine of source.split("\n")) {
    const leadingSpaces = originalLine.match(/^ */)?.[0].length || 0;
    const structuralIndent = fence?.indent ?? Math.min(leadingSpaces, depth * 2);
    const deindented = originalLine.slice(Math.min(leadingSpaces, structuralIndent));
    const fenceMatch = deindented.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (!fence) fence = { indent: structuralIndent, length: fenceMatch[1]!.length, marker };
      else if (fence.marker === marker && fenceMatch[1]!.length >= fence.length) fence = null;
      output.push(rewriteLinks(deindented));
      continue;
    }

    if (fence) {
      output.push(deindented);
      continue;
    }

    if (/^\s*:{2,}\s*$/.test(deindented)) {
      depth = Math.max(0, depth - 1);
      continue;
    }

    const directive = deindented.match(/^\s*:{2,}([a-z][a-z0-9-]*)(?:\{([^}]*)\})?\s*$/i);
    if (directive) {
      const label = directiveLabel((directive[1] || "").toLowerCase(), directive[2]);
      if (label) output.push(label, "");
      depth += 1;
      continue;
    }

    output.push(rewriteLinks(deindented));
  }

  return output.join("\n");
}

export function toRawMarkdown(source: string) {
  const { body, frontmatter } = splitFrontmatter(source);
  const title = frontmatter.title;
  const content = stripPresentationDirectives(cardListsOutsideFences(body)).trim();
  const document = title && !content.startsWith("# ") ? `# ${title}\n\n${content}` : content;
  return `${document}\n`;
}
