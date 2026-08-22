import type { FileUIPart } from "ai";
import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from "vue";

export interface PendingAttachment {
  file: File;
  id: string;
  previewUrl?: string;
}

export interface UseAgentAttachmentsOptions {
  accept?: string;
  maxFiles?: number;
  maxSize?: number;
  multiple?: boolean;
  onReject?: (file: File, reason: "count" | "size" | "type") => void;
}

export interface AgentAttachments {
  accept: ComputedRef<string | undefined>;
  add: (files: FileList | Iterable<File>) => void;
  clear: () => void;
  files: Ref<PendingAttachment[]>;
  inputProps: ComputedRef<{ accept?: string; multiple: boolean; type: "file" }>;
  remove: (id: string) => void;
  toFileParts: () => Promise<FileUIPart[]>;
}

function matchesAccept(file: File, accept: string | undefined): boolean {
  if (!accept) return true;
  return accept.split(",").some((entry) => {
    const value = entry.trim();
    if (value.startsWith(".")) return file.name.toLowerCase().endsWith(value.toLowerCase());
    if (value.endsWith("/*")) return file.type.startsWith(value.slice(0, -1));
    return file.type === value;
  });
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

export async function fileToUIPart(file: File): Promise<FileUIPart> {
  return {
    filename: file.name,
    mediaType: file.type || "application/octet-stream",
    type: "file",
    url: await fileToDataUrl(file),
  };
}

export function useAgentAttachments(options: UseAgentAttachmentsOptions = {}): AgentAttachments {
  const files = ref<PendingAttachment[]>([]);
  const accept = computed(() => options.accept);
  const revoke = (attachment: PendingAttachment) => {
    if (attachment.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(attachment.previewUrl);
  };
  const remove = (id: string) => {
    const attachment = files.value.find((item) => item.id === id);
    if (attachment) revoke(attachment);
    files.value = files.value.filter((item) => item.id !== id);
  };
  const clear = () => {
    files.value.forEach(revoke);
    files.value = [];
  };
  const add = (input: FileList | Iterable<File>) => {
    for (const file of Array.from(input)) {
      if (!matchesAccept(file, options.accept)) {
        options.onReject?.(file, "type");
        continue;
      }
      if (options.maxSize !== undefined && file.size > options.maxSize) {
        options.onReject?.(file, "size");
        continue;
      }
      if (
        (!options.multiple && files.value.length > 0) ||
        (options.maxFiles !== undefined && files.value.length >= options.maxFiles)
      ) {
        options.onReject?.(file, "count");
        continue;
      }
      const previewUrl =
        file.type.startsWith("image/") && typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : undefined;
      files.value.push({
        file,
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${file.name}`,
        previewUrl,
      });
    }
  };
  onScopeDispose(clear);
  return {
    accept,
    add,
    clear,
    files,
    inputProps: computed(() => ({
      accept: options.accept,
      multiple: options.multiple ?? true,
      type: "file" as const,
    })),
    remove,
    async toFileParts() {
      return Promise.all(files.value.map(({ file }) => fileToUIPart(file)));
    },
  };
}
