import type { FileUIPart } from "ai";

/** The files after a pick: added to the current ones, or only the last one when the prompt takes a single file. */
export function nextPromptFiles(current: readonly FileUIPart[], selected: readonly FileUIPart[], single: boolean): readonly FileUIPart[] {
  return single ? selected.slice(-1) : [...current, ...selected];
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

/** Reads a file into an AI SDK file part with a data URL, as the model receives it. */
export function fileToUIPart(file: File): Promise<FileUIPart> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new DOMException(`Could not read ${file.name}.`, "NotReadableError"));
    reader.onload = () => resolve({ filename: file.name, mediaType: file.type || "application/octet-stream", type: "file", url: String(reader.result) });
    reader.readAsDataURL(file);
  });
}

/** Whether the device has only coarse pointers, such as a phone. A tablet with a trackpad or a mouse is not touch only. */
export function touchOnly(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
}
