import { getCurrentScope, type MaybeRefOrGetter, onScopeDispose, readonly, ref, type Ref, toValue } from "vue";

/** The text to copy, or a function that returns it, such as one that fetches the Markdown of a page. */
export type CopyValue = string | (() => string | Promise<string>);

export interface UseCopyOptions {
  /** How long, in ms, `copied` and `failed` stay `true`. A ref or a getter is read at each copy. */
  duration?: MaybeRefOrGetter<number | undefined>;
}

export interface UseCopyReturn {
  /** Writes the text to the clipboard. Resolves to `true` when it was copied. It never rejects. */
  copy: (value: CopyValue) => Promise<boolean>;
  /** `true` for `duration` ms after a copy. */
  copied: Readonly<Ref<boolean>>;
  /** `true` for `duration` ms after a copy that the browser refused. */
  failed: Readonly<Ref<boolean>>;
}

/** Writes the text. Resolves to `false` when the browser refuses, and rejects when the text failed to load. */
async function writeClipboard(value: CopyValue): Promise<boolean> {
  const text = typeof value === "function" ? value() : value;
  try {
    if (await writeClipboardApi(text)) return true;
  }
  catch {
    // Outside a secure context, such as a dev server on a LAN address, the clipboard API refuses.
  }
  // The older copy command still works there. When the text failed to load, this rethrows that failure.
  return copyWithCommand(await text);
}

/** Resolves to `false` when the browser has no clipboard API. */
async function writeClipboardApi(text: string | Promise<string>): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== "function") return false;
  if (typeof text === "string") await clipboard.writeText(text);
  // Safari allows a write only during the click. A ClipboardItem takes the pending text, so the write starts now.
  else if (typeof ClipboardItem === "function" && typeof clipboard.write === "function") {
    await clipboard.write([new ClipboardItem({ "text/plain": text.then((resolved) => new Blob([resolved], { type: "text/plain" })) })]);
  }
  else await clipboard.writeText(await text);
  return true;
}

/** Copies through a hidden text area and `document.execCommand("copy")`. Returns `false` when the browser refuses. */
function copyWithCommand(text: string): boolean {
  const doc = globalThis.document;
  if (typeof doc?.execCommand !== "function" || !doc.body) return false;
  const focused = doc.activeElement;
  const area = doc.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.opacity = "0";
  doc.body.append(area);
  area.focus({ preventScroll: true });
  area.select();
  try {
    return doc.execCommand("copy");
  }
  catch {
    return false;
  }
  finally {
    area.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
}

/**
 * The clipboard logic of `CopyButton`, for a control that copies as one part of a larger action, such as the item
 * "Copy link" in a menu. The caller shows the result, for example with a toast.
 */
export function useCopy(options: UseCopyOptions = {}): UseCopyReturn {
  const copied = ref(false);
  const failed = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (getCurrentScope()) onScopeDispose(() => clearTimeout(timer));

  async function copy(value: CopyValue): Promise<boolean> {
    clearTimeout(timer);
    copied.value = false;
    failed.value = false;
    try {
      copied.value = await writeClipboard(value);
    }
    catch {
      copied.value = false;
    }
    failed.value = !copied.value;
    timer = setTimeout(() => {
      copied.value = false;
      failed.value = false;
    }, toValue(options.duration) ?? 2_000);
    return copied.value;
  }

  return { copy, copied: readonly(copied), failed: readonly(failed) };
}
