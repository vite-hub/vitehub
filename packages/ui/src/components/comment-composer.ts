import type { CommentUser } from "@vite-hub/comments/client";
import type { FileUIPart } from "ai";
import {
  computed,
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  type PropType,
  ref,
  type SlotsType,
  useId,
  type VNode,
  watch,
} from "vue";
import {
  consumedPointerEvents,
  pathOf,
  shakeEventName,
  swallowNextClick,
  useDocumentPointerDown,
} from "../internal/comment-outside.ts";
import { mentionQuery, rankPeople } from "../internal/comment-mentions.ts";
import { displayName, toPerson } from "../internal/comment-person.ts";
import { injectComments } from "../internal/comments-context.ts";
import { matchesAccept } from "../internal/prompt-files.ts";
import { AvatarStack } from "./avatar-stack.ts";
import { PromptInput, type PromptInputSubmit } from "./prompt-input.ts";

export type CommentComposerVariant = "comment" | "reply" | "edit";

/** What `submit` sends: the text, the ids of the people mentioned in it, and the attached files. */
export interface CommentComposerSubmit {
  body: string;
  mentions: string[];
  files: File[];
}

/** The scope of the `mention-item` slot: one person of the mention menu, and whether the arrow keys are on it. */
export interface CommentMentionItemScope {
  person: CommentUser;
  active: boolean;
}

export type CommentComposerSlots = {
  /** Above the text field, such as a field for a suggested change. */
  extra?: () => VNode[];
  /** One person of the mention menu. */
  "mention-item"?: (scope: CommentMentionItemScope) => VNode[];
};

interface MentionMenu {
  /** Where the `@` sits in the text. */
  start: number;
  /** Text through the caret when the lookup started. */
  before: string;
  items: CommentUser[];
  index: number;
}

const placeholders: Record<CommentComposerVariant, string> = {
  comment: "Add a comment",
  edit: "Edit your comment",
  reply: "Reply",
};

/** The name of the send button. A comment on a page is sent as a comment, and an answer in a thread as a reply. */
const sendLabels: Record<CommentComposerVariant, string> = {
  comment: "Comment",
  edit: "Save",
  reply: "Reply",
};

const labels: Record<CommentComposerVariant, string> = {
  comment: "Comment",
  edit: "Edit comment",
  reply: "Reply",
};

// PromptInput takes a file from the clipboard when it is an image, or when the clipboard has no text.
const pastedFiles = (clipboard: DataTransfer): File[] => {
  const hasText = clipboard.getData("text/plain").length > 0;
  return Array.from(clipboard.files).filter((file) => file.type.startsWith("image/") || !hasText);
};

// The Figma composer. Enter sends and Shift+Enter breaks the line. Esc in an empty composer closes it. Esc in a composer
// with text, and a click outside it, shake the box and keep the focus and the text, so a draft is never lost by accident.
export const CommentComposer = defineComponent({
  name: "CommentComposer",
  props: {
    modelValue: { default: "", type: String },
    /** The ids of the people mentioned so far. */
    mentions: { default: () => [], type: Array as PropType<string[]> },
    /** The attached files. Use `v-model:files` to clear them after a send. Without it the composer keeps its own list. */
    files: { type: Array as PropType<File[]> },
    /** Whose avatar shows beside the box. They are not suggested in the mention menu. */
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
    /** People whose names the text may hold, such as the authors of a thread. Only mentions of a person whose `@name` is still in the text are sent. */
    people: { default: () => [], type: Array as PropType<CommentUser[]> },
    /** The ids of the people in the conversation. The mention menu shows them first. */
    participants: { default: () => [], type: Array as PropType<string[]> },
    /** Finds people for `@mentions`. Defaults to the comments state of the nearest `CommentLayer` or `CommentPanel`, else to `people`. */
    users: { type: Function as PropType<(query: string) => Promise<CommentUser[]>> },
    /** Paste, drop, or pick files. An edit never has attachments. */
    attachments: { default: true, type: Boolean },
    /** The file types to take, as the `accept` of a file input, such as `image/*`. */
    accept: { type: String },
    /** Send files without text. Default: on for a reply, off for a new comment. */
    allowEmpty: { default: undefined, type: Boolean },
  },
  emits: ["update:modelValue", "update:mentions", "update:files", "submit", "cancel"],
  // SAFETY: Vue uses Object as its runtime slots marker.
  slots: Object as SlotsType<CommentComposerSlots>,
  setup(props, { emit, expose, slots }) {
    const comments = injectComments();
    const root = ref<HTMLElement | null>(null);
    const shaking = ref<"shake" | "flash" | null>(null);
    const menu = ref<MentionMenu | null>(null);
    const hint = ref<string | undefined>();
    const dragging = ref(false);
    const picked = new Map<string, string>();
    const menuId = useId();
    const optionId = (index: number) => `${menuId}-option-${index}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lookup = 0;
    let mentionCaret: number | undefined;
    // The `@` whose menu Esc closed. It stays closed until the caret leaves that mention.
    let dismissed: number | undefined;

    const localFiles = ref<File[]>([]);
    const files = computed(() => props.files ?? localFiles.value);
    const attachmentsOn = computed(() => props.attachments && props.variant !== "edit");
    const allowEmpty = computed(() => props.allowEmpty ?? props.variant === "reply");
    // PromptInput shows a file as a UI part. The preview is an object URL, so no file is read before it is sent.
    const parts = new WeakMap<File, FileUIPart>();
    const urls = new Set<string>();
    const partOf = (file: File): FileUIPart => {
      let part = parts.get(file);
      if (!part) {
        part = { filename: file.name, mediaType: file.type || "application/octet-stream", type: "file", url: URL.createObjectURL(file) };
        parts.set(file, part);
        urls.add(part.url);
      }
      return part;
    };
    const fileParts = computed(() => files.value.map(partOf));
    watch(() => [...files.value], (next, previous) => {
      for (const file of previous) {
        const part = parts.get(file);
        if (part && !next.includes(file)) {
          URL.revokeObjectURL(part.url);
          urls.delete(part.url);
          parts.delete(file);
        }
      }
    });
    function setFiles(next: File[]) {
      localFiles.value = next;
      hint.value = undefined;
      emit("update:files", next);
    }
    function addFiles(list: Iterable<File>): File[] {
      if (!attachmentsOn.value) return [];
      const accepted = Array.from(list).filter((file) => matchesAccept(file, props.accept));
      if (accepted.length > 0) setFiles([...files.value, ...accepted]);
      return accepted;
    }

    const knownPeople = computed(() => [...props.people, ...(comments?.people.value ?? [])]);
    const nameOf = (id: string): string | undefined => {
      const person = knownPeople.value.find((entry) => entry.id === id);
      return picked.get(id) ?? (person ? displayName(person) : undefined);
    };
    const search = (): ((query: string) => Promise<CommentUser[]>) | undefined => {
      if (props.users) return props.users;
      if (comments) return comments.users;
      return props.people.length > 0 ? async () => props.people : undefined;
    };
    const self = () => props.user?.id ?? comments?.user.value?.id;
    const textarea = () => root.value?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
    const hasText = () => props.modelValue.trim().length > 0;
    const hasContent = () => hasText() || files.value.length > 0;
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
      for (const url of urls) URL.revokeObjectURL(url);
    });
    expose({ focus, shake });

    // The textarea is the combobox, and PromptInput owns it, so its ARIA is set here.
    watch(menu, (open) => {
      const field = textarea();
      if (!field) return;
      field.setAttribute("role", "combobox");
      field.setAttribute("aria-autocomplete", "list");
      field.setAttribute("aria-expanded", String(open !== null));
      if (open) {
        field.setAttribute("aria-controls", `${menuId}-list`);
        field.setAttribute("aria-activedescendant", optionId(open.index));
      } else {
        field.removeAttribute("aria-controls");
        field.removeAttribute("aria-activedescendant");
      }
    }, { deep: true });

    useDocumentPointerDown((event) => {
      // A click inside a shadow root is retargeted to its host here, so ask the composed path.
      if (!props.guard || !root.value || pathOf(event).includes(root.value)) return;
      consumedPointerEvents.add(event);
      if (hasContent()) {
        event.stopPropagation();
        swallowNextClick();
        void shake();
      } else emit("cancel");
    });

    function checkSelection() {
      const field = textarea();
      if (!field || (field.selectionStart === mentionCaret && field.selectionEnd === mentionCaret)) return;
      lookup++;
      mentionCaret = undefined;
      menu.value = null;
    }

    function choose(person: CommentUser) {
      checkSelection();
      const field = textarea();
      const current = menu.value;
      if (!field || !current) return;
      if (field.selectionStart !== field.selectionEnd || field.value.slice(0, field.selectionStart) !== current.before) {
        menu.value = null;
        return;
      }
      const caret = field.selectionStart;
      const insert = `@${displayName(person)} `;
      const next = props.modelValue.slice(0, current.start) + insert + props.modelValue.slice(caret).replace(/^ /u, "");
      picked.set(person.id, displayName(person));
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
      const run = ++lookup;
      mentionCaret = field.selectionStart;
      const find = search();
      const before = field.value.slice(0, field.selectionStart);
      const found = field.selectionStart === field.selectionEnd ? mentionQuery(field.value, field.selectionStart) : undefined;
      if (found?.start !== dismissed) dismissed = undefined;
      if (!find || !found || found.start === dismissed) {
        menu.value = null;
        return;
      }
      const results = await find(found.query).catch(() => []);
      const items = rankPeople(results, found.query, { exclude: self(), participants: props.participants });
      checkSelection();
      if (run !== lookup) return;
      const sameToken = field.selectionStart === field.selectionEnd && field.value.slice(0, field.selectionStart) === before;
      menu.value = sameToken && items.length > 0 ? { before, index: 0, items, start: found.start } : null;
    }

    function submit(payload: PromptInputSubmit) {
      if (props.busy) return;
      const sent = [...files.value];
      if (!payload.text && (sent.length === 0 || !allowEmpty.value)) {
        if (sent.length > 0) hint.value = "Write a comment to send with the files.";
        return;
      }
      const mentions = props.mentions.filter((id) => {
        // A person whose name is not known cannot be checked against the text, so the mention goes.
        const name = nameOf(id);
        if (name === undefined) return false;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^\\p{L}\\p{N}\\p{M}_])@${escaped}(?=$|[^\\p{L}\\p{N}\\p{M}_])`, "iu").test(payload.text);
      });
      emit("submit", { body: payload.text, files: sent, mentions: [...mentions] } satisfies CommentComposerSubmit);
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
      if (open) {
        dismissed = open.start;
        menu.value = null;
      } else if (hasContent()) void shake();
      else emit("cancel");
    }

    const hasFiles = (event: DragEvent) => attachmentsOn.value && (event.dataTransfer?.types.includes("Files") ?? false);

    return () =>
      h(
        "div",
        {
          "data-busy": props.busy ? "true" : undefined,
          "data-dirty": hasContent() ? "true" : undefined,
          "data-dragging": dragging.value ? "true" : undefined,
          "data-shake": shaking.value ?? undefined,
          "data-slot": "comment-composer",
          "data-variant": props.variant,
          // Capture, so the mention menu and Esc see the key before the prompt does.
          onKeydownCapture: keydown,
          onKeyupCapture: checkSelection,
          onClickCapture: checkSelection,
          onSelectCapture: checkSelection,
          onInputCapture: (event: Event) => {
            if (event.target instanceof HTMLTextAreaElement) void findPeople(event.target);
          },
          // PromptInput reads the pasted files. The composer keeps them as files, so it only stops the text paste here.
          onPasteCapture: (event: ClipboardEvent) => {
            if (!attachmentsOn.value || !event.clipboardData) return;
            if (pastedFiles(event.clipboardData).some((file) => matchesAccept(file, props.accept))) event.preventDefault();
          },
          onDragover: (event: DragEvent) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            dragging.value = true;
          },
          onDragleave: (event: DragEvent) => {
            if (!(event.relatedTarget instanceof Node) || !root.value?.contains(event.relatedTarget)) dragging.value = false;
          },
          onDrop: (event: DragEvent) => {
            dragging.value = false;
            if (!hasFiles(event)) return;
            event.preventDefault();
            addFiles(event.dataTransfer?.files ?? []);
            focus();
          },
          ref: root,
        },
        [
          props.user
            ? h(AvatarStack, { "aria-hidden": "true", people: [toPerson(props.user)], size: "sm" })
            : null,
          h("div", { "data-slot": "comment-composer-box" }, [
            slots.extra ? h("div", { "data-slot": "comment-composer-extra" }, slots.extra()) : null,
            h(PromptInput, {
              accept: props.accept,
              "aria-label": labels[props.variant],
              attachments: attachmentsOn.value,
              files: fileParts.value,
              filterFiles: (list: readonly File[]) => {
                addFiles(list);
                return [];
              },
              modelValue: props.modelValue,
              placeholder: props.placeholder ?? placeholders[props.variant],
              submitLabel: sendLabels[props.variant],
              onSubmit: submit,
              "onUpdate:files": (next: readonly FileUIPart[]) => setFiles(files.value.filter((file) => next.includes(partOf(file)))),
              "onUpdate:modelValue": (value: string) => emit("update:modelValue", value),
            }),
            menu.value
              ? h(
                  "ul",
                  { "aria-label": "People", "data-slot": "comment-composer-mentions", id: `${menuId}-list`, role: "listbox" },
                  menu.value.items.map((person, index) => {
                    const active = index === menu.value?.index;
                    return h(
                      "li",
                      {
                        "aria-selected": String(active),
                        "data-slot": "comment-composer-mention",
                        id: optionId(index),
                        key: person.id,
                        // Keep the focus in the box, or the menu would close before the click lands.
                        onMousedown: (event: MouseEvent) => {
                          event.preventDefault();
                          choose(person);
                        },
                        role: "option",
                      },
                      slots["mention-item"]?.({ active, person }) ?? [
                        h(AvatarStack, { "aria-hidden": "true", people: [toPerson(person)], size: "sm" }),
                        h("span", { "data-slot": "comment-composer-mention-name" }, displayName(person)),
                      ],
                    );
                  }),
                )
              : null,
            (props.error ?? hint.value) ? h("p", { "data-slot": "comment-composer-error", role: "alert" }, props.error ?? hint.value) : null,
          ]),
        ],
      );
  },
});
