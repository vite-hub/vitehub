import type { App, ComputedRef, InjectionKey, MaybeRefOrGetter, Plugin } from "vue";
import { computed, inject, toValue } from "vue";
import { uiComponentsKey, type ViteHubUIComponents } from "./internal/nuxt-ui.ts";
import { vRing } from "./components/motion.ts";
import { setMotionPressMode, type MotionPressMode } from "./motion/effects/press.ts";
import { installMotion } from "./motion/install.ts";

export type { ViteHubUIComponentName, ViteHubUIComponents } from "./internal/nuxt-ui.ts";
export type { MotionPressMode } from "./motion/effects/press.ts";

export interface ViteHubUIDefaults {
  markdown?: { class?: string };
  messageScroller?: {
    edgeThreshold?: number;
    previousItemPeek?: number;
  };
}

/**
 * The icons that the parts render, by name. The names from `arrowLeft` to `stop` are Nuxt UI's `appConfig.ui.icons`
 * names. The others are ViteHub names, for actions that Nuxt UI has no icon for. In Nuxt, the module reads both from
 * the app config for you. Each one falls back to Lucide.
 */
export interface ViteHubUIIconOptions {
  /** The back button of a comment thread. */
  arrowLeft?: string;
  /** The send button of a prompt. */
  arrowUp?: string;
  /** Resolve on a comment thread. */
  check?: string;
  /** The previous picture of an image preview. */
  chevronLeft?: string;
  /** The next picture of an image preview. */
  chevronRight?: string;
  /** Close a comment thread, an image preview, or remove an attachment. */
  close?: string;
  copy?: string;
  copyCheck?: string;
  /** The spinner of `CopyButton` while its text loads. */
  loading?: string;
  /** Open the original of an image preview. */
  external?: string;
  /** An attachment that is not an image. */
  file?: string;
  /** The attach button of a prompt. */
  plus?: string;
  /** The retry button of a prompt after an error. */
  reload?: string;
  /** The stop button of a prompt while it streams. */
  stop?: string;
  /** The comment mode button of `CommentToolbar`. */
  comment?: string;
  /** The thread list button of `CommentToolbar`. */
  commentList?: string;
  /** The page comment button of `CommentToolbar`. */
  commentPage?: string;
  /** Delete a comment. */
  delete?: string;
  /** Edit a comment. */
  edit?: string;
  /** Reopen a resolved comment thread. */
  reopen?: string;
}

/** What the motion layer moves. */
export interface ViteHubUIMotionOptions {
  /**
   * Which elements squash on a pointer press. `"buttons"`: native buttons under 48px high and at most four times as wide
   * as high. `"opt-in"`: none. `"all"`: buttons, links, tabs, radios, options, menu items, summaries, and checkboxes.
   * In every mode, `data-motion-press` on an element opts it in, `data-motion-press="icon"` squashes only its icon, and
   * `data-motion-press="none"` opts out the element and everything in it. Default: `"buttons"`.
   */
  press?: MotionPressMode;
}

export interface ViteHubUIOptions {
  defaults?: ViteHubUIDefaults;
  /** Components that the parts render instead of Nuxt UI's, by name, such as `{ UIcon: MyIcon }`. */
  components?: ViteHubUIComponents;
  /** Icons by name, such as `vitehubTheme.icons` from `@vite-hub/ui/theme`. A ref or a getter keeps them reactive. */
  icons?: MaybeRefOrGetter<ViteHubUIIconOptions | undefined>;
  /**
   * The motion layer of `@vite-hub/ui/motion`: press, toggle, select, drag, and appear motion by role. It starts in the
   * browser and stops when the app unmounts. `false` leaves it off, and an object sets what it moves. Default: `true`.
   */
  motion?: boolean | ViteHubUIMotionOptions;
}

export interface ResolvedViteHubUIDefaults {
  markdown: { class: string };
  messageScroller: {
    edgeThreshold: number;
    previousItemPeek: number;
  };
}

const defaultOptions: ResolvedViteHubUIDefaults = {
  markdown: { class: "vh-typeset vh-typeset-chat" },
  messageScroller: { edgeThreshold: 8, previousItemPeek: 64 },
};

export const ViteHubUIInjectionKey: InjectionKey<ResolvedViteHubUIDefaults> = Symbol("ViteHubUI");
const iconsKey: InjectionKey<MaybeRefOrGetter<ViteHubUIIconOptions | undefined>> = Symbol("ViteHubUIIcons");
const motionEnabledKey: InjectionKey<boolean> = Symbol("ViteHubUIMotionEnabled");

const defaultIcons: Required<ViteHubUIIconOptions> = {
  arrowLeft: "i-lucide-arrow-left",
  arrowUp: "i-lucide-arrow-up",
  check: "i-lucide-check",
  chevronLeft: "i-lucide-chevron-left",
  chevronRight: "i-lucide-chevron-right",
  close: "i-lucide-x",
  copy: "i-lucide-copy",
  copyCheck: "i-lucide-check",
  loading: "i-lucide-loader-circle",
  external: "i-lucide-external-link",
  file: "i-lucide-file",
  plus: "i-lucide-plus",
  reload: "i-lucide-refresh-cw",
  stop: "i-lucide-square",
  comment: "i-lucide-message-circle",
  commentList: "i-lucide-list",
  commentPage: "i-lucide-square-pen",
  delete: "i-lucide-trash-2",
  edit: "i-lucide-pencil",
  reopen: "i-lucide-rotate-ccw",
};

export function resolveViteHubUIDefaults(
  options: ViteHubUIOptions = {},
): ResolvedViteHubUIDefaults {
  return {
    markdown: { ...defaultOptions.markdown, ...options.defaults?.markdown },
    messageScroller: { ...defaultOptions.messageScroller, ...options.defaults?.messageScroller },
  };
}

export function useViteHubUI(): ResolvedViteHubUIDefaults {
  return inject(ViteHubUIInjectionKey, defaultOptions);
}

export function useViteHubUIMotionEnabled(): boolean {
  return inject(motionEnabledKey, true);
}

/** The icons that the parts render. It reads them on each render, so a reactive app config updates them. */
export function useViteHubUIIcons(): ComputedRef<Required<ViteHubUIIconOptions>> {
  const icons = inject(iconsKey, undefined);
  return computed(() => ({
    ...defaultIcons,
    ...Object.fromEntries(Object.entries(toValue(icons) ?? {}).filter(([, icon]) => icon)),
  }));
}

export function createViteHubUI(options: ViteHubUIOptions = {}): Plugin {
  return {
    install(app: App) {
      if (options.components) app.provide(uiComponentsKey, options.components);
      if (options.icons) app.provide(iconsKey, options.icons);
      app.provide(ViteHubUIInjectionKey, resolveViteHubUIDefaults(options));
      const motionEnabled = options.motion !== false;
      app.provide(motionEnabledKey, motionEnabled);
      if (motionEnabled && typeof document !== "undefined") {
        const press = typeof options.motion === "object" ? options.motion.press : undefined;
        if (press !== undefined) setMotionPressMode(press);
        app.onUnmount(installMotion());
      }
      app.directive("ring", vRing);
    },
  };
}
