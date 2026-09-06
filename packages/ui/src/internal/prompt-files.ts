import type { FileUIPart } from "ai";

export function nextPromptFiles(
  current: readonly FileUIPart[],
  selected: readonly FileUIPart[],
  multiple: boolean,
): readonly FileUIPart[] {
  return multiple ? [...current, ...selected] : selected.slice(-1);
}
