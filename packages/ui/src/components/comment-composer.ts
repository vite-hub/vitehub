import type { CommentUser } from "@vite-hub/comments/client";
import { defineComponent, h, nextTick, onBeforeUnmount, onMounted, type PropType, ref } from "vue";
import {
  consumedPointerEvents,
  shakeEventName,
  swallowNextClick,
  useDocumentPointerDown,
} from "../internal/comment-outside.ts";
import { AvatarStack } from "./avatar-stack.ts";
import { PromptInput, type PromptInputSubmit } from "./prompt-input.ts";

export type CommentComposerVariant = "comment" | "reply" | "edit";

/** What `submit` sends: the text and the ids of the people mentioned in it. */
export interface CommentComposerSubmit {
  body: string;
  mentions: string[];
}

interface MentionMenu {
  /** Where the `@` sits in the text. */
  start: number;
  items: CommentUser[];
  index: number;
}

const placeholders: Record<CommentComposerVariant, string> = {
  comment: "Add a comment",
  edit: "Edit your comment",
  reply: "Reply",
};

const labels: Record<CommentComposerVariant, string> = {
  comment: "Comment",
  edit: "Edit comment",
  reply: "Reply",
};

// The Figma composer. Enter sends and Shift+Enter breaks the line. Esc in an empty composer closes it. Esc in a composer
// with text, and a click outside it, shake the box and keep the focus and the text, so a draft is never lost by accident.
export const CommentComposer = defineComponent({
  name: "CommentComposer",
  props: {
    modelValue: { default: "", type: String },
    /** The ids of the people mentioned so far. */
    mentions: { default: () => [], type: Array as PropType<string[]> },
    /** Whose avatar shows beside the box. */
    user: { type: Object as PropType<CommentUser> },
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    variant: { default: "comment", type: String as PropType<CommentComposerVariant> },
    placeholder: { type: String },
    /** A send is running. The box keeps its text and cannot send again. */
    busy: { default: false, type: Boolean },
    /** Why the last send failed. */
    error: { type: String },
    /** Focus the box when it appears. */
    autofocus: { default: true, type: Boolean },
    /** Treat a click outside as a close, or as a shake when there is text. Turn it off when the parent decides. */
    guard: { default: true, type: Boolean },
    /** Finds people for `@mentions`. Without it the box has no mention menu. */
    users: { type: Function as PropType<(query: string) => Promise<CommentUser[]>> },
  },
  emits: ["update:modelValue", "update:mentions", "submit", "cancel"],
  setup(props, { emit, expose }) {
    const root = ref<HTMLElement | null>(null);
    const shaking = ref<"shake" | "flash" | null>(null);
    const menu = ref<MentionMenu | null>(null);
    const known = new Map<string, string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lookup = 0;

    const textarea = () => root.value?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
    const hasText = () => props.modelValue.trim().length > 0;
    const focus = () => textarea()?.focus();

    async function shake() {
      const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      // Clear first, so a second shake restarts the animation.
      shaking.value = null;
      await nextTick();
      void root.value?.offsetWidth;
      shaking.value = reduced ? "flash" : "shake";
      clearTimeout(timer);
      timer = setTimeout(() => (shaking.value = null), 450);
      focus();
    }
    const onShake = () => void shake();
    onMounted(() => {
      root.value?.addEventListener(shakeEventName, onShake);
      if (props.autofocus) void nextTick(focus);
    });
    onBeforeUnmount(() => {
      root.value?.removeEventListener(shakeEventName, onShake);
      clearTimeout(timer);
    });
    expose({ focus, shake });

    useDocumentPointerDown((event) => {
      const target = event.target;
      if (!props.guard || !(target instanceof Node) || root.value?.contains(target)) return;
      consumedPointerEvents.add(event);
      if (hasText()) {
        event.stopPropagation();
        swallowNextClick();
        void shake();
      } else emit("cancel");
    });

    function choose(person: CommentUser) {
      const field = textarea();
      const current = menu.value;
      if (!field || !current) return;
      const caret = field.selectionStart;
      const insert = `@${person.name} `;
      const next = props.modelValue.slice(0, current.start) + insert + props.modelValue.slice(caret);
      known.set(person.id, person.name);
      emit("update:modelValue", next);
      if (!props.mentions.includes(person.id)) emit("update:mentions", [...props.mentions, person.id]);
      menu.value = null;
      void nextTick(() => {
        const position = current.start + insert.length;
        field.setSelectionRange(position, position);
        field.focus();
      });
    }

    async function findPeople(field: HTMLTextAreaElement) {
      const search = props.users;
      const before = field.value.slice(0, field.selectionStart);
      const match = /(^|\s)@([^\s@]*)$/.exec(before);
      if (!search || !match) {
        menu.value = null;
        return;
      }
      const start = before.length - match[2]!.length - 1;
      const run = ++lookup;
      const items = await search(match[2]!).catch(() => []);
      if (run !== lookup) return;
      menu.value = items.length > 0 ? { index: 0, items, start } : null;
    }

    function submit(payload: PromptInputSubmit) {
      if (props.busy || !payload.text) return;
      const mentions = props.mentions.filter((id) => {
        const name = known.get(id);
        return name === undefined || payload.text.includes(`@${name}`);
      });
      emit("submit", { body: payload.text, mentions: [...mentions] } satisfies CommentComposerSubmit);
    }

    function keydown(event: KeyboardEvent) {
      if (event.isComposing) return;
      const open = menu.value;
      if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        open.index = (open.index + step + open.items.length) % open.items.length;
        return;
      }
      if (open && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        choose(open.items[open.index]!);
        return;
      }
      if (event.key !== "Escape") return;
      // Esc belongs to the composer while it has the focus, so the page does not leave comment mode.
      event.preventDefault();
      event.stopPropagation();
      if (open) menu.value = null;
      else if (hasText()) void shake();
      else emit("cancel");
    }

    return () =>
      h(
        "div",
        {
          "data-busy": props.busy ? "true" : undefined,
          "data-dirty": hasText() ? "true" : undefined,
          "data-shake": shaking.value ?? undefined,
          "data-slot": "comment-composer",
          "data-variant": props.variant,
          // Capture, so the mention menu and Esc see the key before the prompt does.
          onKeydownCapture: keydown,
          onInputCapture: (event: Event) => {
            if (event.target instanceof HTMLTextAreaElement) void findPeople(event.target);
          },
          ref: root,
        },
        [
          props.user
            ? h(AvatarStack, { "aria-hidden": "true", people: [props.user], size: "sm" })
            : null,
          h("div", { "data-slot": "comment-composer-box" }, [
            h(PromptInput, {
              "aria-label": labels[props.variant],
              attachments: false,
              modelValue: props.modelValue,
              placeholder: props.placeholder ?? placeholders[props.variant],
              onSubmit: submit,
              "onUpdate:modelValue": (value: string) => emit("update:modelValue", value),
            }),
            menu.value
              ? h(
                  "ul",
                  { "aria-label": "People", "data-slot": "comment-composer-mentions", role: "listbox" },
                  menu.value.items.map((person, index) =>
                    h(
                      "li",
                      {
                        "aria-selected": String(index === menu.value?.index),
                        "data-slot": "comment-composer-mention",
                        key: person.id,
                        // Keep the focus in the box, or the menu would close before the click lands.
                        onMousedown: (event: MouseEvent) => {
                          event.preventDefault();
                          choose(person);
                        },
                        role: "option",
                      },
                      person.name,
                    ),
                  ),
                )
              : null,
            props.error ? h("p", { "data-slot": "comment-composer-error", role: "alert" }, props.error) : null,
          ]),
        ],
      );
  },
});
