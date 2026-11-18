import { defineComponent, getCurrentInstance, getCurrentScope, h, type MaybeRefOrGetter, onMounted, onScopeDispose, type PropType, readonly, ref, type Ref, toValue, watch } from "vue";
import { useViteHubUIIcons } from "../config.ts";
import { useUIComponent } from "../internal/nuxt-ui.ts";
import { announce, prepareAnnouncer } from "../internal/announce.ts";
import { ring } from "../motion/helpers/ring.ts";
import { SwapIcon } from "./motion.ts";

/** The text to copy, or a function that returns it, such as one that fetches the Markdown of a page. */
export type CopyValue = string | (() => string | Promise<string>);
export type CopyButtonSize = "xs" | "sm" | "md" | "lg" | "xl";
export type CopyButtonVariant = "ghost" | "outline" | "soft" | "subtle" | "solid" | "link";

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
    }, toValue(options.duration) ?? 2_000);
    return copied.value;
  }

  return { copy, copied: readonly(copied), failed: readonly(failed) };
}

/** Nuxt UI's `leading` slot props of `UButton`: `ui.leadingIcon()` gives the classes of its leading icon. */
interface ButtonLeadingSlotProps {
  ui?: { leadingIcon?: (options: { class?: unknown }) => string };
}

/**
 * A button that copies text. It shows `icon`, or the theme's `copy` icon, and swaps to the theme's `copyCheck` icon for
 * `duration` ms after a copy: the copy icon blurs out and the check draws in, a label changes to `copiedLabel` letter by
 * letter, and the button rings once. It announces "Copied", or "Copy failed" when the browser refuses. Without a label
 * it is an icon-only button named "Copy".
 */
export const CopyButton = defineComponent({
  name: "CopyButton",
  inheritAttrs: false,
  props: {
    // SAFETY: Vue's runtime constructors cannot express the function's return type.
    value: { required: true, type: [String, Function] as PropType<CopyValue> },
    label: { default: undefined, type: String },
    /** The label for `duration` ms after a copy, when the button has a label. */
    copiedLabel: { default: "Copied", type: String },
    /** The icon before a copy, such as `i-lucide-link` for a link. Defaults to the theme's `copy` icon. */
    icon: { default: undefined, type: String },
    ariaLabel: { default: undefined, type: String },
    // SAFETY: Vue's runtime constructor cannot express these string literal unions.
    size: { default: undefined, type: String as PropType<CopyButtonSize> },
    variant: { default: "ghost", type: String as PropType<CopyButtonVariant> },
    /** How long, in ms, the check shows after a copy. */
    duration: { default: 2_000, type: Number },
    /** Call a function `value` when the pointer enters the button or it gets focus, so the click copies text that is already loaded. */
    preload: { default: false, type: Boolean },
  },
  emits: {
    copy: () => true,
    error: () => true,
  },
  setup(props, { attrs, emit, slots }) {
    const UButton = useUIComponent("UButton");
    const icons = useViteHubUIIcons();
    const { copy, copied } = useCopy({ duration: () => props.duration });
    const instance = getCurrentInstance();
    const element = (): Element | undefined => {
      const el: unknown = instance?.proxy?.$el;
      return el instanceof Element ? el : undefined;
    };
    onMounted(() => prepareAnnouncer(element()));

    // The text that a hover or a focus started to load, for the next click. A failed load is dropped, so the click tries again.
    let preloaded: { text: string | Promise<string> } | undefined;
    watch(() => props.value, () => (preloaded = undefined));
    function preload() {
      if (!props.preload || preloaded || typeof props.value !== "function") return;
      const entry = { text: callValue(props.value) };
      preloaded = entry;
      if (typeof entry.text === "string") return;
      entry.text.then(
        (text) => {
          if (preloaded === entry) entry.text = text;
        },
        () => {
          if (preloaded === entry) preloaded = undefined;
        },
      );
    }

    const loading = ref(false);
    async function onClick(event: MouseEvent) {
      const target = event.currentTarget instanceof Element ? event.currentTarget : element();
      let value = props.value;
      if (typeof value === "function") {
        // Call it during the click, and show the loading icon only when the text has to load first. A promise goes to
        // the clipboard inside the click, so the browser accepts the write after the text loads.
        const text = preloaded?.text ?? callValue(value);
        preloaded = undefined;
        value = typeof text === "string" ? text : () => text;
        loading.value = typeof text !== "string";
      }
      const ok = await copy(value);
      loading.value = false;
      announce(target, ok ? "Copied" : "Copy failed");
      if (ok && target instanceof HTMLElement) ring(target);
      if (ok) emit("copy");
      else emit("error");
    }

    // One icon slot for every state: the copy icon, the spinner while a text loads, and the check. The swap blurs the
    // old icon out, and the spinner and the check draw their stroke in.
    const leading = ({ ui }: ButtonLeadingSlotProps) => {
      const iconClass = ui?.leadingIcon?.({ class: leadingIconClass(attrs.ui) });
      const [name, enter] = loading.value
        ? [icons.value.loading, "draw"] as const
        : copied.value ? [icons.value.copyCheck, "draw"] as const : [props.icon ?? icons.value.copy, "blur"] as const;
      return [h(SwapIcon, { class: iconClass, name, enter, spin: loading.value })];
    };

    return () =>
      h(UButton, {
        ...attrs,
        "aria-label": props.ariaLabel ?? (props.label || slots.default ? undefined : "Copy"),
        "data-copied": copied.value ? "" : undefined,
        "data-slot": attrs["data-slot"] ?? "copy-button",
        // The slot draws the icons. The button still needs `icon` to lay out the leading icon and its loading icon.
        icon: copied.value ? icons.value.copyCheck : props.icon ?? icons.value.copy,
        // The layer's label effect morphs the label of the button letter by letter.
        label: props.label && copied.value ? props.copiedLabel : props.label,
        disabled: loading.value || undefined,
        size: props.size,
        variant: props.variant,
        onClick: (event: MouseEvent) => {
          callListener(attrs.onClick, event);
          return onClick(event);
        },
        onFocus: (event: FocusEvent) => {
          callListener(attrs.onFocus, event);
          if (event.currentTarget instanceof Element) prepareAnnouncer(event.currentTarget);
          preload();
        },
        onPointerenter: (event: PointerEvent) => {
          callListener(attrs.onPointerenter, event);
          preload();
        },
      }, {
        leading,
        ...(slots.default ? { default: slots.default } : {}),
      });
  },
});

/** Calls a function `value`. A function that throws gives a rejected promise, so the copy reports the failure. */
function callValue(value: () => string | Promise<string>): string | Promise<string> {
  try {
    return value();
  }
  catch (error) {
    return Promise.reject(error);
  }
}

function leadingIconClass(ui: unknown): unknown {
  return typeof ui === "object" && ui !== null && "leadingIcon" in ui ? ui.leadingIcon : undefined;
}

function callListener(listener: unknown, event: Event): void {
  if (Array.isArray(listener)) {
    for (const handler of listener) if (typeof handler === "function") handler(event);
  }
  else if (typeof listener === "function") listener(event);
}
