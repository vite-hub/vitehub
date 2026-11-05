import type { FileUIPart } from "ai";

export function nextPromptFiles(
  current: readonly FileUIPart[],
  selected: readonly FileUIPart[],
  multiple: boolean,
): readonly FileUIPart[] {
  return multiple ? [...current, ...selected] : selected.slice(-1);
}

/** Whether a file matches an `accept` list of the file input, such as `image/*,.pdf`. */
export function matchesAccept(file: File, accept: string | undefined): boolean {
  if (!accept) return true;
  return accept.split(",").some((entry) => {
    const value = entry.trim();
    if (value.startsWith(".")) return file.name.toLowerCase().endsWith(value.toLowerCase());
    if (value.endsWith("/*")) return file.type.startsWith(value.slice(0, -1));
    return file.type === value;
  });
}
