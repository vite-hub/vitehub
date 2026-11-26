import {
  computed,
  getCurrentInstance,
  isRef,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  shallowRef,
  toRaw,
  toValue,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  type Ref,
  type ShallowRef,
} from "vue";
import {
  createAnchor,
  resolveAnchor,
  type AnchorPoint,
  type AnchorPosition,
  type AnchorTarget,
  type CommentAnchor,
  type CommentDelivery,
  type CommentMessage,
  type CommentsClient,
  type CommentsOutboxEntry,
  type CommentsClientStatus,
  type CommentSubject,
  type CommentThread,
  type CommentUser,
  type CreateAnchorOptions,
} from "@vite-hub/comments/client";
import { uiErrorDiagnostics } from "../error-diagnostics.ts";
import { createCommentVisibility, type CommentVisibility } from "./comment-visibility.ts";
import { hasDirtyComposer, shakeDirtyComposers } from "../internal/comment-outside.ts";
import { useSelectedComment } from "../internal/comment-selection.ts";
import { repliedSinceResolved } from "../internal/comment-status.ts";
import { commentsKey, injectComments } from "../internal/comments-context.ts";

/**
 * Each switch shows one kind of thread. Resolved threads stay hidden until `resolved` is on. A resolved thread with a
 * reply since it was resolved also counts as open, so the reply is seen.
 */
export interface CommentFilterState {
  open: boolean;
  resolved: boolean;
  /** Only threads that the signed-in user started. */
  mine: boolean;
}

/** `page` lists the threads of this page. `site` lists the threads of every page. */
export type CommentScope = "page" | "site";

/** A comment that is being written. It becomes a thread when it is sent. */
export interface CommentDraft {
  anchor: CommentAnchor;
  /** Where the click landed in client coordinates. The pin sits here until its element is measured. */
  point: AnchorPoint;
  body: string;
  mentions: string[];
  /** Attachment keys, such as Blob keys, that the comment sends. */
  attachments: string[];
  /** Files that the composer starts with, such as a screenshot. They upload with the comment, as picked files do. */
  files?: File[];
  busy: boolean;
  error: string | undefined;
}

/** What the signed-in user may do to a thread. `edit` and `delete` name a message; deleting the first one deletes the thread. */
export type CommentThreadAction = "reply" | "resolve" | "edit" | "delete";

/** Whether the signed-in user may do `action`. The parts show only the controls that it allows. The server still decides. */
export type CommentCan = (action: CommentThreadAction, target: { thread: CommentThread; message?: CommentMessage }) => boolean;

/**
 * The permissions that the parts assume without a `can` option: a signed-in user may reply to and resolve any thread,
 * and edit and delete their own messages. Nobody may do anything without a user.
 */
export function defaultCommentCan(user: CommentUser | undefined): CommentCan {
  return (action, { message }) => {
    if (!user) return false;
    if (action === "edit" || action === "delete") return message?.author.id === user.id;
    return true;
  };
}

export interface UseCommentsOptions {
  client: CommentsClient;
  /** What the threads of this page are about. For a page, `{ kind: "page", id: location.pathname }`. */
  subject: MaybeRefOrGetter<CommentSubject>;
  /** The signed-in user. Defaults to `client.user`. */
  user?: MaybeRefOrGetter<CommentUser | undefined>;
  /** People that the app already knows, such as the ones that a server answer named. Their mentions show as chips. */
  people?: MaybeRefOrGetter<readonly CommentUser[]>;
  /** Where anchors are looked up. Defaults to the document. */
  root?: MaybeRefOrGetter<ParentNode | undefined>;
  /** The query parameter that deep-links a thread. Default `"comment"`. */
  param?: string;
  /** The key that toggles comment mode. Default `"c"`. `false` turns the key off. */
  hotkey?: string | false;
  /** Elements that anchors skip. Defaults to the comment UI. */
  ignore?: (element: Element) => boolean;
  /** Where the comment UI lives: the document, or the shadow root of the overlay. Composers are looked up there. Defaults to the document. */
  uiRoot?: MaybeRefOrGetter<ParentNode | undefined>;
  /** The URL of the page that a subject lives on, for a link to a thread. Page subjects use their id as the path. Other subjects need this, or their link is the current page. */
  subjectUrl?: (subject: CommentSubject) => string | undefined;
  /** Where the deep link is read. Defaults to `window.location`. */
  location?: () => Pick<Location, "href" | "origin" | "search">;
  /** Load the threads and listen for keys when the component mounts. Default `true`. Call `start()` yourself when `false`. */
  autoStart?: boolean;
  /** What the signed-in user may do, such as your app's sharing rules. Defaults to `defaultCommentCan()`. */
  can?: CommentCan;
  /**
   * Which comments show on the page. Default `"all"`. Pass a ref to keep the reader's choice, such as one saved in
   * `localStorage`: the state reads and writes it.
   */
  visibility?: CommentVisibility | Ref<CommentVisibility>;
  /** How long a comment or reply that was just sent shows while comments are hidden. Default `2500`. */
  flashMs?: number;
}

/**
 * The comments and replies that the client's outbox saved and did not send yet. Without the `outbox` option of
 * `createCommentsClient()`, it is empty and its actions do nothing.
 */
export interface CommentsOutboxState {
  /** `true` when the client has an outbox. */
  readonly enabled: boolean;
  /** The entries that wait or go out now, in order. */
  readonly queued: ComputedRef<readonly CommentsOutboxEntry[]>;
  /** The entries that the server refused. */
  readonly failures: ComputedRef<readonly CommentsOutboxEntry[]>;
  /** Whether the thread, or one of its messages, is waiting or refused. `undefined` when the server has it. */
  delivery: (threadId: string, messageId?: string) => CommentDelivery | undefined;
  /** Sends the waiting comment or reply `id` now. Without `id`, the whole queue tries again, such as after a sign-in. */
  retry: (id?: string) => Promise<void>;
  /** Removes the waiting comment or reply. `false` while it is on its way. */
  dismiss: (id: string) => Promise<boolean>;
  /** Changes the text of the waiting comment or reply. A refused one goes back in the queue. `false` while it is on its way. */
  edit: (id: string, body: string, mentions?: string[]) => Promise<boolean>;
}

export interface CommentsState {
  readonly client: CommentsClient;
  readonly subject: ComputedRef<CommentSubject>;
  readonly user: ComputedRef<CommentUser | undefined>;
  /** Whether the signed-in user may reply, resolve, edit, or delete. Always false without a user. */
  readonly can: CommentCan;
  /** Every person the state knows: the user, the authors of threads, the people that `users()` found, and `people`. Mentions get their names here. */
  readonly people: ComputedRef<CommentUser[]>;
  /** Comment mode: a click drops a pin. */
  readonly active: Ref<boolean>;
  readonly scope: Ref<CommentScope>;
  readonly filters: CommentFilterState;
  readonly status: Ref<CommentsClientStatus>;
  /** Every thread that the client holds, with the ones that wait in the outbox. */
  readonly threads: ShallowRef<readonly CommentThread[]>;
  readonly outbox: CommentsOutboxState;
  /** The threads of this page that pass the filters. They get pins. */
  readonly pageThreads: ComputedRef<CommentThread[]>;
  /** The threads that pass the filters, for the page or the whole site as `scope` says. The list shows them. */
  readonly listed: ComputedRef<CommentThread[]>;
  readonly openThreads: ComputedRef<CommentThread[]>;
  readonly counts: ComputedRef<{ open: number; resolved: number }>;
  /** Pin positions by thread id, and `"draft"` for the comment being written. */
  readonly positions: ShallowRef<ReadonlyMap<string, AnchorPosition>>;
  readonly draft: Ref<CommentDraft | null>;
  readonly openId: Ref<string | null>;
  readonly hoverId: Ref<string | null>;
  readonly opened: ComputedRef<CommentThread | undefined>;
  readonly listOpen: Ref<boolean>;
  /** Goes up when a composer with text stopped a click or a key. The composer shakes by itself. */
  readonly blocked: Ref<number>;
  /** Which comments show. Writing or opening a comment never changes it. */
  readonly visibility: Ref<CommentVisibility>;
  /**
   * The ids of the threads of this page that get a pin or a mark: all of them, or while comments are hidden, the open
   * thread and each one that was just sent or replied to. The draft always shows.
   */
  readonly shown: ComputedRef<ReadonlySet<string>>;
  /** The ids of threads that stopped showing while comments are hidden, for 180 ms. Their marks play the pop-out. */
  readonly leaving: ComputedRef<ReadonlySet<string>>;
  /** Keeps page marks visible without opening a popover. Call the returned release function when the panel closes. */
  retainMark: (id: string) => () => void;
  isShown: (id: string) => boolean;
  /** Shows the thread for `flashMs` while comments are hidden. `send()`, `create()`, and `reply()` call it. */
  flash: (id: string) => void;
  enter: () => void;
  exit: () => void;
  toggle: () => void;
  /**
   * Starts a draft on a point, an element, a selection, or `"page"`. Ends an empty draft first, and keeps one with text.
   * A pin has no number until the server assigns one. `files` start in its composer, such as a screenshot of the area.
   */
  startDraft: (target: AnchorTarget, options?: CreateAnchorOptions & { files?: File[] }) => void;
  cancelDraft: () => void;
  /**
   * Sends the draft. Resolves with the new thread, or `undefined` when there is nothing to send or the send failed. With
   * an outbox the draft closes at once and the comment shows as pending, so the next draft can start while it is saved
   * and sent; a failure shows on that comment. Without one, the draft is `busy` until the server answers. `files` go
   * with the comment; with an outbox they may be a promise, such as a screenshot that renders after Send.
   */
  send: (options?: { files?: Blob[] | Promise<Blob[]> }) => Promise<CommentThread | undefined>;
  open: (thread: CommentThread | string, options?: { scroll?: boolean }) => void;
  /** Closes the thread, returning false when unsent text prevents closing or navigation. */
  close: () => boolean;
  /** Starts a thread on the subject. The anchor defaults to the whole page. */
  create: (input: { body: string; mentions?: string[]; attachments?: string[]; files?: Blob[] | Promise<Blob[]>; anchor?: CommentAnchor }) => Promise<CommentThread>;
  reply: (threadId: string, body: string, mentions?: string[], attachments?: string[], files?: Blob[] | Promise<Blob[]>) => Promise<CommentThread>;
  edit: (threadId: string, messageId: string, body: string, mentions?: string[]) => Promise<CommentThread>;
  remove: (threadId: string, messageId?: string) => Promise<CommentThread | null>;
  resolve: (threadId: string) => Promise<CommentThread>;
  reopen: (threadId: string) => Promise<CommentThread>;
  /** Finds people for a reply or edit in `threadId`, or for a new thread on the current subject. */
  users: (query: string, threadId?: string) => Promise<CommentUser[]>;
  /** The URL that opens the thread: its page with `?comment=<n>`. */
  link: (thread: CommentThread) => string;
  /** Measures every pin again. The state does it on scroll, resize, and DOM changes. */
  measure: () => void;
  /** Loads the threads and starts the key, layout, and deep-link handling. Returns a function that stops them. */
  start: () => () => void;
}

export const draftPositionKey = "draft";

const uiSelector = "[data-comments-ui]";
const draftComposerSelector = "[data-draft] [data-slot='comment-composer']";

// The comment UI may sit in a shadow root, so an element is also in it when its shadow host is.
function defaultIgnore(element: Element): boolean {
  for (let node: Element | null = element; node; ) {
    if (node.closest(uiSelector)) return true;
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

// Events from a shadow root are retargeted to its host, so the real element is the first one of the composed path.
const elementsOf = (event: Event): Element[] => event.composedPath().filter((node): node is Element => node instanceof Element);

function sameSubject(a: CommentSubject, b: CommentSubject): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function samePosition(a: AnchorPosition | undefined, b: AnchorPosition | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.detached || b.detached) return a.detached === b.detached;
  return a.element === b.element && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.clipped === b.clipped;
}

const editableSelector = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox'], [role='searchbox']";
const isEditable = (path: readonly Element[]): boolean => path.some(element => element.matches(editableSelector));

/** Whether there are files to send. A promise, such as of a screenshot, counts: it settles after Send. */
const someFiles = (files: Blob[] | Promise<Blob[]> | undefined): files is Blob[] | Promise<Blob[]> => files !== undefined && (!Array.isArray(files) || files.length > 0);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "The comment could not be sent. Try again.";
}

/** The comment state of one page. The styled parts, `CommentLayer` and the others, are built on it. */
export function useComments(options: UseCommentsOptions): CommentsState {
  const { client } = options;
  const param = options.param ?? "comment";
  const hotkey = options.hotkey === undefined ? "c" : options.hotkey === false ? false : options.hotkey.toLowerCase();
  const ignore = options.ignore ?? defaultIgnore;
  const subject = computed(() => toValue(options.subject));
  const user = computed(() => toValue(options.user) ?? client.user);
  const active = ref(false);
  const scopeValue = ref<CommentScope>("page");
  const scope = computed({
    get: () => scopeValue.value,
    set: (value: CommentScope) => {
      if (value === scopeValue.value) return;
      if (hasText()) return block();
      scopeValue.value = value;
    },
  });
  const filters = reactive<CommentFilterState>({ open: true, resolved: false, mine: false });
  const status = ref<CommentsClientStatus>(client.status);
  const threads = shallowRef<readonly CommentThread[]>(client.threads);
  const outboxEntries = shallowRef<readonly CommentsOutboxEntry[]>(client.outbox?.entries ?? []);
  const positions = shallowRef<ReadonlyMap<string, AnchorPosition>>(new Map());
  const draft = ref<CommentDraft | null>(null);
  const openId = ref<string | null>(null);
  const retained = shallowRef<ReadonlyMap<symbol, string>>(new Map());
  const retainedIds = computed(() => new Set(retained.value.values()));
  const retainMark = (id: string): (() => void) => {
    const key = Symbol();
    retained.value = new Map(retained.value).set(key, id);
    return () => {
      const next = new Map(retained.value);
      next.delete(key);
      retained.value = next;
    };
  };
  const hoverId = ref<string | null>(null);
  const listOpen = ref(false);
  const blocked = ref(0);

  const isOpen = (thread: CommentThread): boolean => thread.status === "open" || repliedSinceResolved(thread);
  const passes = (thread: CommentThread): boolean => {
    const shown = (filters.open && isOpen(thread)) || (filters.resolved && thread.status === "resolved");
    if (!shown) return false;
    return !filters.mine || thread.author.id === user.value?.id;
  };
  const onPage = (thread: CommentThread): boolean => sameSubject(thread.subject, subject.value);
  const pageThreads = computed(() => threads.value.filter(thread => onPage(thread) && passes(thread)));
  const listed = computed(() =>
    threads.value.filter(thread => (scope.value === "site" || onPage(thread)) && passes(thread)),
  );
  const scoped = computed(() => threads.value.filter(thread => scope.value === "site" || onPage(thread)));
  const openThreads = computed(() => scoped.value.filter(isOpen));
  const counts = computed(() => ({
    open: openThreads.value.length,
    resolved: scoped.value.filter(thread => thread.status === "resolved").length,
  }));
  const opened = useSelectedComment(threads, openId);
  watch(opened, thread => {
    if (thread && thread.id !== openId.value) openId.value = thread.id;
  }, { flush: "sync" });

  const visibility = isRef(options.visibility) ? options.visibility : ref<CommentVisibility>(options.visibility ?? "all");
  const seen = createCommentVisibility({ visibility: visibility.value, flashMs: options.flashMs });
  const seenChanges = ref(0);
  seen.subscribe(() => seenChanges.value++);
  watch(visibility, value => seen.set(value), { flush: "sync" });
  watch(openId, id => seen.open(id), { flush: "sync" });
  watch(hoverId, id => seen.hover(id), { flush: "sync" });
  // Open panels and active flashes keep their marks even when a filter would hide them.
  const marked = computed(() => {
    void seenChanges.value;
    const ids = new Set(pageThreads.value.map(thread => thread.id));
    if (opened.value && onPage(opened.value)) ids.add(opened.value.id);
    for (const thread of threads.value) {
      const temporary = visibility.value === "hidden" && (seen.isShown(thread.id) || seen.leaving.includes(thread.id));
      if (onPage(thread) && (retainedIds.value.has(thread.id) || temporary)) ids.add(thread.id);
    }
    return ids;
  });
  const shown = computed<ReadonlySet<string>>(() => {
    void seenChanges.value;
    return new Set([...marked.value].filter(id => seen.isShown(id) || retainedIds.value.has(id)));
  });
  const leaving = computed<ReadonlySet<string>>(() => {
    void seenChanges.value;
    return new Set(seen.leaving.filter(id => marked.value.has(id) && !retainedIds.value.has(id)));
  });
  const flash = (id: string): void => seen.flash(id);

  const root = (): ParentNode => toValue(options.root) ?? document;
  const uiRoot = (): ParentNode => toValue(options.uiRoot) ?? document;

  function measure(): void {
    const next = new Map<string, AnchorPosition>();
    for (const thread of threads.value.filter(thread => marked.value.has(thread.id))) next.set(thread.id, resolveAnchor(thread.anchor, root()));
    if (draft.value) next.set(draftPositionKey, resolveAnchor(draft.value.anchor, root()));
    const previous = positions.value;
    const same = next.size === previous.size && [...next].every(([key, position]) => samePosition(position, previous.get(key)));
    if (!same) positions.value = next;
  }

  // Without a draft, the composer of one that was just sent or closed is on its way out of the DOM, and holds nothing.
  const hasText = (): boolean => (draft.value?.body.trim().length ?? 0) > 0 || hasDirtyComposer(uiRoot(), draft.value ? undefined : draftComposerSelector);
  const block = (escape = false): void => {
    blocked.value++;
    shakeDirtyComposers(uiRoot(), escape);
  };

  function enter(): void {
    active.value = true;
    const selection = typeof window === "undefined" ? undefined : window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const container = selection.getRangeAt(0).commonAncestorContainer;
      const element = container instanceof Element ? container : container.parentElement;
      // A selection that the page removed since, such as after a router swapped the body, has nothing to anchor to.
      if (element?.isConnected && !ignore(element)) {
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        try {
          startDraft(selection, { point: { x: rect.left, y: rect.top } });
          selection.removeAllRanges();
        } catch {
          // Comment mode stays on, and a click drops the pin.
        }
      }
    }
  }
  function cancelDraft(): void {
    draft.value = null;
  }
  function close(): boolean {
    if (hasText()) {
      block();
      return false;
    }
    openId.value = null;
    hoverId.value = null;
    return true;
  }
  function exit(escape = false): void {
    if (hasText()) return block(escape);
    cancelDraft();
    close();
    active.value = false;
  }
  function toggle(): void {
    if (active.value) exit();
    else enter();
  }

  function startDraft(target: AnchorTarget, { files, ...anchorOptions }: CreateAnchorOptions & { files?: File[] } = {}): void {
    if (hasText()) return block();
    close();
    const anchor = createAnchor(target, { root: root(), ignore, ...anchorOptions });
    let point = anchorOptions.point ?? { x: 0, y: 0 };
    if (target === "page") {
      // A comment on the whole page has no spot, so its composer opens near the top.
      point = { x: Math.max(16, window.innerWidth / 2 - 180), y: 96 };
    } else if ("nodeType" in target) {
      const box = target.getBoundingClientRect();
      point = anchorOptions.point ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    } else if (!("rangeCount" in target) && !("startContainer" in target)) {
      point = target;
    }
    draft.value = { anchor, point, body: "", mentions: [], attachments: [], ...(files?.length ? { files } : {}), busy: false, error: undefined };
    measure();
  }

  async function send(sendOptions: { files?: Blob[] | Promise<Blob[]> } = {}): Promise<CommentThread | undefined> {
    const current = draft.value;
    const body = current?.body.trim() ?? "";
    const files = sendOptions.files;
    const hasFiles = someFiles(files);
    if (!current || current.busy || (!body && current.attachments.length === 0 && !hasFiles)) return undefined;
    const submittedBody = current.body;
    const mentions = [...current.mentions];
    const attachments = [...current.attachments];
    const input = {
      subject: subject.value,
      anchor: toRaw(current.anchor),
      body,
      mentions,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(hasFiles ? { files } : {}),
    };
    current.error = undefined;
    if (client.outbox) {
      // The outbox shows the comment at once and keeps it until it is sent, so the draft closes now and the next one can start.
      draft.value = null;
      try {
        const thread = await client.create(input);
        flash(thread.id);
        return thread;
      } catch (error) {
        // Nothing was queued. The text comes back, unless another draft took its place.
        current.error = describeError(error);
        if (!draft.value) draft.value = current;
        return undefined;
      }
    }
    current.busy = true;
    try {
      const thread = await client.create(input);
      current.busy = false;
      flash(thread.id);
      if (draft.value === current && current.body === submittedBody && current.mentions.length === mentions.length && current.mentions.every((id, index) => id === mentions[index])) draft.value = null;
      return thread;
    } catch (error) {
      current.busy = false;
      current.error = describeError(error);
      return undefined;
    }
  }

  // The element may not be on the page yet, for example while a route renders. Try for a few seconds, then give up.
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  function reveal(id: string): void {
    clearTimeout(revealTimer);
    let attempts = 0;
    const tick = (): void => {
      measure();
      const position = positions.value.get(id);
      if (position && !position.detached) {
        position.element?.scrollIntoView?.({ block: "center" });
        measure();
      } else if (++attempts < 20) {
        revealTimer = setTimeout(tick, 150);
      }
    };
    tick();
  }

  function open(thread: CommentThread | string, openOptions: { scroll?: boolean } = {}): void {
    const id = typeof thread === "string" ? thread : thread.id;
    if (hasText()) return block();
    cancelDraft();
    openId.value = id;
    hoverId.value = null;
    const found = threads.value.find(entry => entry.id === id);
    if (found && onPage(found)) {
      if (openOptions.scroll) reveal(id);
      else measure();
    }
  }

  function link(thread: CommentThread): string {
    const location = options.location?.() ?? window.location;
    const base = options.subjectUrl?.(thread.subject) ?? (thread.subject.kind === "page" ? thread.subject.id : location.href);
    const url = new URL(base, location.origin);
    url.searchParams.set(param, String(thread.n));
    // URL normalization can produce a pathname that reparses as a protocol-relative link.
    const pathname = url.pathname.startsWith("//") ? `/%2F${url.pathname.slice(2)}` : url.pathname;
    return `${pathname}${url.search}${url.hash}`;
  }

  let deepLinked = false;
  function applyDeepLink(): void {
    if (deepLinked || status.value !== "ready") return;
    deepLinked = true;
    const location = options.location?.() ?? window.location;
    const n = Number(new URLSearchParams(location.search).get(param));
    if (!Number.isInteger(n) || n < 1) return;
    const thread = threads.value.find(entry => entry.n === n && onPage(entry));
    if (!thread) return;
    // A deep link shows its thread, even a resolved one that a filter hides.
    if (thread.status === "resolved") filters.resolved = true;
    filters.mine = false;
    open(thread, { scroll: true });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    const path = elementsOf(event);
    const origin = path[0];
    if (event.key === "Escape") {
      if (path.some(element => element.matches("[data-slot='comment-composer']"))) return;
      if (active.value || draft.value || openId.value) exit(true);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isEditable(path)) return;
    // The keyboard way to drop a pin: in comment mode, Enter on the focused element comments on it.
    if (event.key === "Enter" && active.value && origin && !path.some(ignore) && origin !== document.body && origin !== document.documentElement) {
      event.preventDefault();
      try {
        startDraft(origin);
      } catch {
        // Nothing of the page to comment on.
      }
      return;
    }
    if (hotkey === false || event.key.toLowerCase() !== hotkey) return;
    event.preventDefault();
    toggle();
  }

  function start(): () => void {
    const stops: Array<() => void> = [];
    // Set before `client.start()`: a new query makes an answer that is still on its way stale.
    client.query = scope.value === "page" ? { subject: subject.value } : {};
    stops.push(client.onChange(() => {
      status.value = client.status;
      threads.value = client.threads;
      outboxEntries.value = client.outbox?.entries ?? [];
    }));
    status.value = client.status;
    threads.value = client.threads;
    stops.push(client.start());
    document.addEventListener("keydown", onKeydown);
    stops.push(() => document.removeEventListener("keydown", onKeydown));

    let frame = 0;
    const schedule = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    // Images and fonts that load later move the page.
    window.addEventListener("load", schedule, { capture: true });
    document.fonts?.addEventListener("loadingdone", schedule);
    const onPopstate = (): void => {
      deepLinked = false;
      applyDeepLink();
    };
    window.addEventListener("popstate", onPopstate);
    // Hosts with History API routing can supply a reactive location without synthesizing browser events.
    stops.push(watch(() => options.location?.().search, onPopstate));
    // The comment UI changes the DOM too, and measuring after that would never settle. Only changes that move things count.
    const observer = new MutationObserver(records => {
      if (records.every(record => record.target instanceof Element && defaultIgnore(record.target))) return;
      schedule();
    });
    const observeOptions = {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    };
    stops.push(watch(root, value => {
      observer.disconnect();
      observer.observe(document.documentElement, observeOptions);
      // Shadow mutations do not cross the host. Keep watching the outer layout as well.
      if (value !== document) observer.observe(value, observeOptions);
      schedule();
    }, { immediate: true, flush: "post" }));
    // A box that resizes without a DOM change, such as one that follows its container, moves its pins.
    const resizes = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    const watched = new Set<Element>();
    const follow = (): void => {
      const now = new Set<Element>();
      for (const position of positions.value.values()) if (!position.detached && position.element) now.add(position.element);
      for (const element of watched) {
        if (!now.has(element)) {
          resizes?.unobserve(element);
          watched.delete(element);
        }
      }
      for (const element of now) {
        if (!watched.has(element)) {
          resizes?.observe(element);
          watched.add(element);
        }
      }
    };
    stops.push(() => {
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      window.removeEventListener("load", schedule, { capture: true });
      window.removeEventListener("popstate", onPopstate);
      document.fonts?.removeEventListener("loadingdone", schedule);
      observer.disconnect();
      resizes?.disconnect();
      clearTimeout(revealTimer);
      if (frame) cancelAnimationFrame(frame);
      seen.stop();
    });

    stops.push(watch(positions, follow, { flush: "post" }));
    stops.push(watch(
      [marked, () => draft.value?.anchor, openId],
      () => measure(),
      { flush: "post" },
    ));
    stops.push(watch(() => status.value === "ready", ready => ready && applyDeepLink(), { immediate: true }));
    // By value: a parent that re-renders with a new `{ kind, id }` object for the same page must not reset the draft.
    stops.push(watch(() => `${subject.value.kind}\u0000${subject.value.id}\u0000${scope.value}`, () => {
      client.query = scope.value === "page" ? { subject: subject.value } : {};
      cancelDraft();
      openId.value = null;
      hoverId.value = null;
      deepLinked = false;
      client.refresh().catch(() => undefined);
    }));
    return () => {
      for (const stop of stops.splice(0)) stop();
    };
  }

  const found = shallowRef<ReadonlyMap<string, CommentUser>>(new Map());
  const people = computed(() => {
    const known = new Map<string, CommentUser>();
    const add = (person: CommentUser | undefined) => {
      if (person && (!known.has(person.id) || person.name)) known.set(person.id, person);
    };
    for (const person of found.value.values()) add(person);
    for (const person of toValue(options.people) ?? []) add(person);
    for (const thread of threads.value) {
      add(thread.author);
      add(thread.resolvedBy);
      for (const message of thread.messages) add(message.author);
    }
    add(user.value);
    return [...known.values()];
  });
  async function users(query: string, threadId?: string): Promise<CommentUser[]> {
    const result = await client.users({ query, ...(threadId ? { threadId } : { subject: subject.value }) });
    if (result.some(person => found.value.get(person.id) !== person)) {
      const next = new Map(found.value);
      for (const person of result) next.set(person.id, person);
      found.value = next;
    }
    return result;
  }

  const can: CommentCan = (action, target) => user.value !== undefined && (options.can ?? defaultCommentCan(user.value))(action, target);

  const outbox: CommentsOutboxState = {
    enabled: client.outbox !== undefined,
    queued: computed(() => outboxEntries.value.filter(entry => entry.status !== "failed")),
    failures: computed(() => outboxEntries.value.filter(entry => entry.status === "failed")),
    delivery(threadId, messageId) {
      const thread = threads.value.find(item => item.id === threadId);
      return messageId === undefined ? thread?.delivery : thread?.messages.find(item => item.id === messageId)?.delivery;
    },
    retry: async id => client.outbox?.retry(id),
    dismiss: async id => (await client.outbox?.dismiss(id)) ?? false,
    edit: async (id, body, mentions) => (await client.outbox?.edit(id, body, mentions)) ?? false,
  };

  const state: CommentsState = {
    client,
    subject,
    user,
    can,
    people,
    active,
    scope,
    filters,
    status,
    threads,
    outbox,
    pageThreads,
    listed,
    openThreads,
    counts,
    positions,
    draft,
    openId,
    hoverId,
    opened,
    listOpen,
    blocked,
    visibility,
    shown,
    leaving,
    retainMark,
    isShown: id => shown.value.has(id),
    flash,
    enter,
    exit,
    toggle,
    startDraft,
    cancelDraft,
    send,
    open,
    close,
    create: async ({ anchor = { kind: "page" }, attachments, body, files, mentions }) => {
      const thread = await client.create({ subject: subject.value, anchor, body, mentions, ...(attachments?.length ? { attachments } : {}), ...(someFiles(files) ? { files } : {}) });
      flash(thread.id);
      return thread;
    },
    reply: async (threadId, body, mentions, attachments, files) => {
      const thread = await client.reply({ threadId, body, mentions, ...(attachments?.length ? { attachments } : {}), ...(someFiles(files) ? { files } : {}) });
      flash(threadId);
      return thread;
    },
    edit: (threadId, messageId, body, mentions) => client.edit({ threadId, messageId, body, mentions }),
    remove: async (threadId, messageId) => {
      const next = await client.delete({ threadId, messageId });
      if (!next && openId.value === threadId) {
        openId.value = null;
        hoverId.value = null;
      }
      return next;
    },
    resolve: threadId => client.resolve({ threadId }),
    reopen: threadId => client.reopen({ threadId }),
    users,
    link,
    measure,
    start,
  };

  if (options.autoStart !== false && getCurrentInstance()) {
    let stop: (() => void) | undefined;
    onMounted(() => {
      stop = start();
    });
    onBeforeUnmount(() => stop?.());
  }
  return state;
}

/** Makes `state` the one that `CommentToolbar`, `CommentList`, and `CommentFilters` use inside this component tree. */
export function provideComments(state: CommentsState): void {
  provide(commentsKey, state);
}

/** The state that a comment part uses: the one you pass, else the one of the nearest `CommentLayer` or `provideComments()`. Call it in `setup()`. */
export function useCommentsContext(state?: CommentsState): CommentsState {
  const found = state ?? injectComments();
  if (!found) {
    throw uiErrorDiagnostics.UI_R0002({
      message: "Comment parts need a comments state. Put them inside CommentLayer, or pass the result of useComments() as the `comments` prop.",
    });
  }
  return found;
}
