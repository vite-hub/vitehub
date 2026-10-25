import {
  computed,
  getCurrentInstance,
  inject,
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
  type InjectionKey,
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
  type CommentsClient,
  type CommentsClientStatus,
  type CommentSubject,
  type CommentThread,
  type CommentUser,
  type CreateAnchorOptions,
} from "@vite-hub/comments/client";
import { uiErrorDiagnostics } from "../error-diagnostics.ts";
import { hasDirtyComposer, shakeDirtyComposers } from "../internal/comment-outside.ts";

/** Each switch shows one kind of thread. Resolved threads stay hidden until `resolved` is on. */
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
  busy: boolean;
  error: string | undefined;
}

export interface UseCommentsOptions {
  client: CommentsClient;
  /** What the threads of this page are about. For a page, `{ kind: "page", id: location.pathname }`. */
  subject: MaybeRefOrGetter<CommentSubject>;
  /** The signed-in user. Defaults to `client.user`. */
  user?: MaybeRefOrGetter<CommentUser | undefined>;
  /** Where anchors are looked up. Defaults to the document. */
  root?: MaybeRefOrGetter<ParentNode | undefined>;
  /** The query parameter that deep-links a thread. Default `"comment"`. */
  param?: string;
  /** The key that toggles comment mode. Default `"c"`. `false` turns the key off. */
  hotkey?: string | false;
  /** Elements that anchors skip. Defaults to the comment UI. */
  ignore?: (element: Element) => boolean;
  /** Where the deep link is read. Defaults to `window.location`. */
  location?: () => Pick<Location, "href" | "origin" | "search">;
  /** Load the threads and listen for keys when the component mounts. Default `true`. Call `start()` yourself when `false`. */
  autoStart?: boolean;
}

export interface CommentsState {
  readonly client: CommentsClient;
  readonly subject: ComputedRef<CommentSubject>;
  readonly user: ComputedRef<CommentUser | undefined>;
  /** Comment mode: a click drops a pin. */
  readonly active: Ref<boolean>;
  readonly scope: Ref<CommentScope>;
  readonly filters: CommentFilterState;
  readonly status: Ref<CommentsClientStatus>;
  /** Every thread that the client holds. */
  readonly threads: ShallowRef<readonly CommentThread[]>;
  /** The threads of this page that pass the filters. They get pins. */
  readonly pageThreads: ComputedRef<CommentThread[]>;
  /** The threads that pass the filters, for the page or the whole site as `scope` says. The list shows them. */
  readonly listed: ComputedRef<CommentThread[]>;
  readonly counts: ComputedRef<{ open: number; resolved: number }>;
  /** Pin positions by thread id, and `"draft"` for the comment being written. */
  readonly positions: ShallowRef<ReadonlyMap<string, AnchorPosition>>;
  readonly draft: Ref<CommentDraft | null>;
  /** The number that the draft pin shows. The server assigns the final one. */
  readonly nextNumber: ComputedRef<number>;
  readonly openId: Ref<string | null>;
  readonly hoverId: Ref<string | null>;
  readonly opened: ComputedRef<CommentThread | undefined>;
  readonly listOpen: Ref<boolean>;
  /** Goes up when a composer with text stopped a click or a key. The composer shakes by itself. */
  readonly blocked: Ref<number>;
  enter: () => void;
  exit: () => void;
  toggle: () => void;
  /** Starts a draft on a point, an element, a selection, or `"page"`. Ends an empty draft first, and keeps one with text. */
  startDraft: (target: AnchorTarget, options?: CreateAnchorOptions) => void;
  cancelDraft: () => void;
  /** Sends the draft. Resolves with the new thread, or `undefined` when there is nothing to send or the send failed. */
  send: () => Promise<CommentThread | undefined>;
  open: (thread: CommentThread | string, options?: { scroll?: boolean }) => void;
  close: () => void;
  reply: (threadId: string, body: string, mentions?: string[]) => Promise<CommentThread>;
  edit: (threadId: string, messageId: string, body: string, mentions?: string[]) => Promise<CommentThread>;
  remove: (threadId: string, messageId?: string) => Promise<CommentThread | null>;
  resolve: (threadId: string) => Promise<CommentThread>;
  reopen: (threadId: string) => Promise<CommentThread>;
  users: (query: string) => Promise<CommentUser[]>;
  /** The URL that opens the thread: its page with `?comment=<n>`. */
  link: (thread: CommentThread) => string;
  /** Measures every pin again. The state does it on scroll, resize, and DOM changes. */
  measure: () => void;
  /** Loads the threads and starts the key, layout, and deep-link handling. Returns a function that stops them. */
  start: () => () => void;
}

const commentsKey: InjectionKey<CommentsState> = Symbol("ViteHubComments");

export const draftPositionKey = "draft";

const uiSelector = "[data-comments-ui]";
const defaultIgnore = (element: Element): boolean => element.closest(uiSelector) !== null;

function sameSubject(a: CommentSubject, b: CommentSubject): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function samePosition(a: AnchorPosition | undefined, b: AnchorPosition | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.detached || b.detached) return a.detached === b.detached;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "The comment could not be sent. Try again.";
}

/** The comment state of one page. The styled parts, `CommentLayer` and the others, are built on it. */
export function useComments(options: UseCommentsOptions): CommentsState {
  const { client } = options;
  const param = options.param ?? "comment";
  const hotkey = options.hotkey === undefined ? "c" : options.hotkey;
  const ignore = options.ignore ?? defaultIgnore;
  const subject = computed(() => toValue(options.subject));
  const user = computed(() => toValue(options.user) ?? client.user);
  const active = ref(false);
  const scope = ref<CommentScope>("page");
  const filters = reactive<CommentFilterState>({ open: true, resolved: false, mine: false });
  const status = ref<CommentsClientStatus>(client.status);
  const threads = shallowRef<readonly CommentThread[]>(client.threads);
  const positions = shallowRef<ReadonlyMap<string, AnchorPosition>>(new Map());
  const draft = ref<CommentDraft | null>(null);
  const openId = ref<string | null>(null);
  const hoverId = ref<string | null>(null);
  const listOpen = ref(false);
  const blocked = ref(0);

  const passes = (thread: CommentThread): boolean => {
    if (thread.status === "open" ? !filters.open : !filters.resolved) return false;
    return !filters.mine || thread.author.id === user.value?.id;
  };
  const onPage = (thread: CommentThread): boolean => sameSubject(thread.subject, subject.value);
  const pageThreads = computed(() => threads.value.filter(thread => onPage(thread) && passes(thread)));
  const listed = computed(() =>
    threads.value.filter(thread => (scope.value === "site" || onPage(thread)) && passes(thread)),
  );
  const counts = computed(() => {
    const scoped = threads.value.filter(thread => scope.value === "site" || onPage(thread));
    return {
      open: scoped.filter(thread => thread.status === "open").length,
      resolved: scoped.filter(thread => thread.status === "resolved").length,
    };
  });
  const nextNumber = computed(() => Math.max(0, ...threads.value.map(thread => thread.n)) + 1);
  const opened = computed(() => threads.value.find(thread => thread.id === openId.value));

  const root = (): ParentNode => toValue(options.root) ?? document;

  function measure(): void {
    const next = new Map<string, AnchorPosition>();
    for (const thread of pageThreads.value) next.set(thread.id, resolveAnchor(thread.anchor, root()));
    // An open thread keeps its pin even when a filter would hide it.
    const current = opened.value;
    if (current && onPage(current) && !next.has(current.id)) next.set(current.id, resolveAnchor(current.anchor, root()));
    if (draft.value) next.set(draftPositionKey, resolveAnchor(draft.value.anchor, root()));
    const previous = positions.value;
    const same = next.size === previous.size && [...next].every(([key, position]) => samePosition(position, previous.get(key)));
    if (!same) positions.value = next;
  }

  const hasText = (): boolean => (draft.value?.body.trim().length ?? 0) > 0 || hasDirtyComposer();
  const block = (): void => {
    blocked.value++;
    shakeDirtyComposers();
  };

  function enter(): void {
    active.value = true;
    const selection = typeof window === "undefined" ? undefined : window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const container = selection.getRangeAt(0).commonAncestorContainer;
      const element = container instanceof Element ? container : container.parentElement;
      if (element && !ignore(element)) {
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        startDraft(selection, { point: { x: rect.left, y: rect.top } });
        selection.removeAllRanges();
      }
    }
  }
  function cancelDraft(): void {
    draft.value = null;
  }
  function close(): void {
    openId.value = null;
    hoverId.value = null;
  }
  function exit(): void {
    if (hasText()) return block();
    cancelDraft();
    close();
    active.value = false;
  }
  function toggle(): void {
    if (active.value) exit();
    else enter();
  }

  function startDraft(target: AnchorTarget, anchorOptions: CreateAnchorOptions = {}): void {
    if (hasText()) return block();
    close();
    const anchor = createAnchor(target, { root: root(), ignore, ...anchorOptions });
    const isPoint = typeof target === "object" && !("nodeType" in target) && !("rangeCount" in target) && !("startContainer" in target);
    const point = isPoint ? target : (anchorOptions.point ?? { x: 0, y: 0 });
    draft.value = { anchor, point, body: "", mentions: [], busy: false, error: undefined };
    measure();
  }

  async function send(): Promise<CommentThread | undefined> {
    const current = draft.value;
    const body = current?.body.trim() ?? "";
    if (!current || current.busy || !body) return undefined;
    current.busy = true;
    current.error = undefined;
    try {
      const thread = await client.create({
        subject: subject.value,
        anchor: toRaw(current.anchor),
        body,
        mentions: [...current.mentions],
      });
      if (draft.value === current) draft.value = null;
      return thread;
    } catch (error) {
      current.busy = false;
      current.error = describeError(error);
      return undefined;
    }
  }

  function open(thread: CommentThread | string, openOptions: { scroll?: boolean } = {}): void {
    const id = typeof thread === "string" ? thread : thread.id;
    if (hasText()) return block();
    cancelDraft();
    openId.value = id;
    hoverId.value = null;
    const found = threads.value.find(entry => entry.id === id);
    if (found && onPage(found)) {
      measure();
      const position = positions.value.get(id);
      if (openOptions.scroll && position && !position.detached) position.element?.scrollIntoView?.({ block: "center" });
      if (openOptions.scroll) measure();
    }
  }

  function link(thread: CommentThread): string {
    const location = options.location?.() ?? window.location;
    const url = new URL(thread.subject.kind === "page" ? thread.subject.id : location.href, location.origin);
    url.searchParams.set(param, String(thread.n));
    return `${url.pathname}${url.search}${url.hash}`;
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
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape") {
      if (event.target instanceof Element && event.target.closest("[data-slot='comment-composer']")) return;
      if (active.value || draft.value || openId.value) exit();
      return;
    }
    if (hotkey === false || event.key.toLowerCase() !== hotkey) return;
    if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return;
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
    const observer = new MutationObserver(records => {
      // The comment UI changes the DOM too. Measuring after that would never settle.
      if (records.every(record => record.target instanceof Element && record.target.closest(uiSelector))) return;
      schedule();
    });
    observer.observe(document.documentElement, { attributes: true, characterData: true, childList: true, subtree: true });
    stops.push(() => {
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    });

    stops.push(watch(
      [pageThreads, () => draft.value?.anchor, openId],
      () => measure(),
      { flush: "post" },
    ));
    stops.push(watch(() => status.value === "ready", ready => ready && applyDeepLink(), { immediate: true }));
    stops.push(watch([subject, scope], () => {
      client.query = scope.value === "page" ? { subject: subject.value } : {};
      cancelDraft();
      close();
      client.refresh().catch(() => undefined);
    }));
    return () => {
      for (const stop of stops.splice(0)) stop();
    };
  }

  const state: CommentsState = {
    client,
    subject,
    user,
    active,
    scope,
    filters,
    status,
    threads,
    pageThreads,
    listed,
    counts,
    positions,
    draft,
    nextNumber,
    openId,
    hoverId,
    opened,
    listOpen,
    blocked,
    enter,
    exit,
    toggle,
    startDraft,
    cancelDraft,
    send,
    open,
    close,
    reply: (threadId, body, mentions) => client.reply({ threadId, body, mentions }),
    edit: (threadId, messageId, body, mentions) => client.edit({ threadId, messageId, body, mentions }),
    remove: (threadId, messageId) => client.delete({ threadId, messageId }),
    resolve: threadId => client.resolve({ threadId }),
    reopen: threadId => client.reopen({ threadId }),
    users: query => client.users({ query }),
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
  const found = state ?? inject(commentsKey, null);
  if (!found) {
    throw uiErrorDiagnostics.UI_R0002({
      message: "Comment parts need a comments state. Put them inside CommentLayer, or pass the result of useComments() as the `comments` prop.",
    });
  }
  return found;
}
