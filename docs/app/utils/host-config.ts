// A primitive hero shows a `vite.config.ts` written for one host. These helpers rewrite that file for another host:
// the `host` line, the options of `vitehub({...})` that the host needs, and the imports those options use.
// Route files never change, which is the point of the picker.

/** The hosts of the hero picker, in display order. Each one is also the value of `host`. */
export const pickerHosts = ["node", "cloudflare", "vercel", "netlify", "deno"] as const;
export type PickerHost = (typeof pickerHosts)[number];

/** One option of `vitehub({...})` as a host needs it. */
export type HostOption = {
  /** TypeScript source of the value, such as `true`. Lines after the first are indented relative to the option. */
  value: string;
  /** The comment line above the option, true for this host. It replaces the comment lines that are there. */
  comment?: string;
};

/** What the config of one host sets. A host without an entry does not support the feature. */
export type HostConfig = {
  options: Record<string, HostOption>;
  /** Options that the host does not need. They go away with their comment lines. */
  remove?: readonly string[];
  /** Import lines that the options use. */
  imports?: readonly string[];
};

export type HostConfigs = Partial<Record<PickerHost, HostConfig>>;

const hostPattern = /(\bhost:\s*)'([\w-]+)'/;

function isPickerHost(value: string): value is PickerHost {
  return (pickerHosts as readonly string[]).includes(value);
}

/** The host that a config file is written for, read from its `host` line. */
export function configHost(code: string): PickerHost | undefined {
  const host = code.match(hostPattern)?.[2];
  return host && isPickerHost(host) ? host : undefined;
}

/** The index of the line where a value that starts on line `start` ends, by bracket depth outside strings and comments. */
function valueEnd(lines: string[], start: number, column: number): number {
  let depth = 0;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    let quote = "";
    for (let char = index === start ? column : 0; char < line.length; char++) {
      const value = line[char]!;
      if (quote) {
        if (value === "\\") char++;
        else if (value === quote) quote = "";
      } else if (value === "'" || value === "\"" || value === "`") quote = value;
      else if (value === "/" && line[char + 1] === "/") break;
      else if ("{[(".includes(value)) depth++;
      else if ("}])".includes(value)) depth--;
    }
    if (depth <= 0) return index;
  }
  throw new Error(`The value on line ${start + 1} does not close.`);
}

/**
 * Finds one option: its comment lines, its first line, and its last line.
 * The option must be on its own line, as in a `vitehub({...})` call written one option a line.
 */
function findOption(lines: string[], name: string) {
  const pattern = new RegExp(`^(\\s*)${name}: `);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start === -1) throw new Error(`The config has no \`${name}\` option on its own line.`);
  const indent = lines[start]!.match(pattern)![1]!;
  const end = valueEnd(lines, start, indent.length + name.length + 2);
  let first = start;
  while (first > 0 && /^\s*\/\//.test(lines[first - 1]!)) first--;
  return { end, first, indent, start };
}

function setOption(lines: string[], name: string, option: HostOption): string[] {
  const { end, first, indent, start } = findOption(lines, name);
  const value = option.value.split("\n").map((line, index) => (index === 0 ? `${indent}${name}: ${line}` : `${indent}${line}`));
  value[value.length - 1] += ",";
  const comment = option.comment === undefined ? lines.slice(first, start) : [`${indent}// ${option.comment}`];
  return [...lines.slice(0, first), ...comment, ...value, ...lines.slice(end + 1)];
}

function removeOption(lines: string[], name: string): string[] {
  const { end, first } = findOption(lines, name);
  return [...lines.slice(0, first), ...lines.slice(end + 1)];
}

/** Removes the imports that only other hosts use, and adds the missing ones after the last import. */
function setImports(lines: string[], wanted: readonly string[], known: ReadonlySet<string>): string[] {
  const kept = lines.filter((line) => !known.has(line) || wanted.includes(line));
  const missing = wanted.filter((line) => !kept.includes(line));
  const last = kept.findLastIndex((line) => line.startsWith("import "));
  return [...kept.slice(0, last + 1), ...missing, ...kept.slice(last + 1)];
}

/**
 * Rewrites a config file for `host`. It sets the host and the host's options, removes the options it does not
 * need, and keeps every other line.
 * Rewrite the authored code each time, not an earlier result, so the authored host gets the authored code back.
 * Returns `undefined` when the host does not support the feature.
 */
export function rewriteHostConfig(code: string, configs: HostConfigs, host: PickerHost): string | undefined {
  const config = configs[host];
  if (!config) return undefined;
  if (!hostPattern.test(code)) throw new Error("The config has no `host: '<host>'` line.");
  let lines = code.replace(hostPattern, `$1'${host}'`).split("\n");
  for (const [name, option] of Object.entries(config.options)) lines = setOption(lines, name, option);
  for (const name of config.remove ?? []) lines = removeOption(lines, name);
  const known = new Set(Object.values(configs).flatMap((entry) => entry.imports ?? []));
  return setImports(lines, config.imports ?? [], known).join("\n");
}

/** Indexes of the lines of `after` that are not in `before`, matched as a longest common subsequence. */
export function changedLines(before: string, after: string): Set<number> {
  const left = before.split("\n");
  const right = after.split("\n");
  // lengths[i][j] is the length of the longest common subsequence of left[i..] and right[j..].
  const lengths = Array.from({ length: left.length + 1 }, () => Array.from({ length: right.length + 1 }, () => 0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      lengths[i]![j] = left[i] === right[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const changed = new Set<number>();
  let i = 0;
  let j = 0;
  while (j < right.length) {
    if (i < left.length && left[i] === right[j]) {
      i++;
      j++;
    } else if (i < left.length && lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++;
    else changed.add(j++);
  }
  return changed;
}
