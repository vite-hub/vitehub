import { defineComponent, getCurrentInstance, getCurrentScope, h, onMounted, onScopeDispose, type PropType, readonly, ref, type Ref } from "vue";
import { useViteHubUIIcons } from "../config.ts";
import { useUIComponent } from "../internal/nuxt-ui.ts";
import { announce, prepareAnnouncer } from "../internal/announce.ts";

/** The text to copy, or a function that returns it, such as one that fetches the Markdown of a page. */
export type CopyValue = string | (() => string | Promise<string>);
export type CopyButtonSize = "xs" | "sm" | "md" | "lg" | "xl";
export type CopyButtonVariant = "ghost" | "outline" | "soft" | "subtle" | "solid" | "link";

export interface UseCopyOptions {
  /** How long, in ms, `copied` and `failed` stay `true`. */
  duration?: number;
}

export interface UseCopyReturn {
  /** Writes the text to the clipboard. Resolves to `true` when it was copied. It never rejects. */
  copy: (value: CopyValue) => Promise<boolean>;
  /** `true` for `duration` ms after a copy. */
  copied: Readonly<Ref<boolean>>;
  /** `true` for `duration` ms after a copy that the browser refused. */
  failed: Readonly<Ref<boolean>>;
}

async function writeClipboard(value: CopyValue): Promise<void> {
  const text = typeof value === "function" ? value() : value;
  try {
    await writeClipboardApi(text);
  }
  catch (error) {
    // Outside a secure context, such as a dev server on a LAN address, the clipboard API is missing or refuses.
    // The older copy command still works there. When the text failed to load, this rethrows that failure.
    if (!copyWithCommand(await text)) throw error;
  }
}

async function writeClipboardApi(text: string | Promise<string>): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== "function") throw new Error("The clipboard is not available.");
  if (typeof text === "string") return clipboard.writeText(text);
  // Safari allows a write only during the click. A ClipboardItem takes the pending text, so the write starts now.
  if (typeof ClipboardItem === "function" && typeof clipboard.write === "function") {
    return clipboard.write([new ClipboardItem({ "text/plain": text.then((resolved) => new Blob([resolved], { type: "text/plain" })) })]);
  }
  return clipboard.writeText(await text);
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
  const duration = options.duration ?? 2_000;
  const copied = ref(false);
  const failed = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (getCurrentScope()) onScopeDispose(() => clearTimeout(timer));

  async function copy(value: CopyValue): Promise<boolean> {
    clearTimeout(timer);
    copied.value = false;
    failed.value = false;
    try {
      await writeClipboard(value);
      copied.value = true;
    }
    catch {
      failed.value = true;
    }
    timer = setTimeout(() => {
      copied.value = false;
      failed.value = false;
    }, duration);
    return copied.value;
  }

  return { copy, copied: readonly(copied), failed: readonly(failed) };
}

/**
 * A button that copies text. It shows `icon`, or the theme's `copy` icon, and swaps to the theme's `copyCheck` icon for
 * 2 seconds after a copy. It announces "Copied", or "Copy failed" when the browser refuses. Without a label it is an
 * icon-only button named "Copy".
 */
export const CopyButton = defineComponent({
  name: "CopyButton",
  inheritAttrs: false,
  props: {
    // SAFETY: Vue's runtime constructors cannot express the function's return type.
    value: { required: true, type: [String, Function] as PropType<CopyValue> },
    label: { default: undefined, type: String },
    /** The icon before a copy, such as `i-lucide-link` for a link. Defaults to the theme's `copy` icon. */
    icon: { default: undefined, type: String },
    ariaLabel: { default: undefined, type: String },
    // SAFETY: Vue's runtime constructor cannot express these string literal unions.
    size: { default: undefined, type: String as PropType<CopyButtonSize> },
    variant: { default: "ghost", type: String as PropType<CopyButtonVariant> },
  },
  emits: {
    copy: () => true,
    error: () => true,
  },
  setup(props, { attrs, emit, slots }) {
    const UButton = useUIComponent("UButton");
    const icons = useViteHubUIIcons();
    const { copy, copied } = useCopy();
    const instance = getCurrentInstance();
    const element = (): Element | undefined => {
      const el: unknown = instance?.proxy?.$el;
      return el instanceof Element ? el : undefined;
    };
    onMounted(() => prepareAnnouncer(element()));

    const loading = ref(false);
    async function onClick(event: MouseEvent) {
      const target = event.currentTarget instanceof Element ? event.currentTarget : element();
      let value = props.value;
      if (typeof value === "function") {
        // Call it during the click, and show the loading icon only when the text has to load first.
        try {
          const text = value();
          value = typeof text === "string" ? text : () => text;
          loading.value = typeof text !== "string";
        }
        catch (error) {
          value = () => Promise.reject(error);
        }
      }
      const ok = await copy(value);
      loading.value = false;
      announce(target, ok ? "Copied" : "Copy failed");
      if (ok) emit("copy");
      else emit("error");
    }

    return () =>
      h(UButton, {
        ...attrs,
        "aria-label": props.ariaLabel ?? (props.label || slots.default ? undefined : "Copy"),
        "data-copied": copied.value ? "" : undefined,
        "data-slot": attrs["data-slot"] ?? "copy-button",
        icon: copied.value ? icons.value.copyCheck : props.icon ?? icons.value.copy,
        label: props.label,
        loading: loading.value,
        size: props.size,
        variant: props.variant,
        onClick: (event: MouseEvent) => {
          callListener(attrs.onClick, event);
          return onClick(event);
        },
        onFocus: (event: FocusEvent) => {
          callListener(attrs.onFocus, event);
          if (event.currentTarget instanceof Element) prepareAnnouncer(event.currentTarget);
        },
      }, slots.default ? { default: slots.default } : undefined);
  },
});

function callListener(listener: unknown, event: Event): void {
  if (Array.isArray(listener)) {
    for (const handler of listener) if (typeof handler === "function") handler(event);
  }
  else if (typeof listener === "function") listener(event);
}
