import { onBeforeUnmount, onMounted } from "vue";

// A pointerdown that a composer or a thread already used. The comment layer skips it, so one click never does two things.
export const consumedPointerEvents = new WeakSet<Event>();

// A pointerdown that was stopped still ends in a click. Swallow that click too, so a pin under the pointer does not open.
export function swallowNextClick(): void {
  const stop = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
    cleanup();
  };
  const cleanup = () => {
    document.removeEventListener("click", stop, true);
    document.removeEventListener("pointerdown", cleanup, true);
  };
  document.addEventListener("click", stop, true);
  document.addEventListener("pointerdown", cleanup, true);
}

// Runs `handler` for every pointerdown on the page, before the page sees it.
export function useDocumentPointerDown(handler: (event: Event) => void): void {
  onMounted(() => document.addEventListener("pointerdown", handler, true));
  onBeforeUnmount(() => document.removeEventListener("pointerdown", handler, true));
}

export const shakeEventName = "comments:shake";

const dirtySelector = "[data-slot='comment-composer'][data-dirty='true']";

// A composer with text, the new comment, a reply, or an edit, keeps the page from closing it by accident.
export function hasDirtyComposer(): boolean {
  return typeof document !== "undefined" && document.querySelector(dirtySelector) !== null;
}

// Shakes every composer that has text. Returns whether there was one.
export function shakeDirtyComposers(): boolean {
  const dirty = [...document.querySelectorAll(dirtySelector)];
  for (const composer of dirty) composer.dispatchEvent(new CustomEvent(shakeEventName));
  return dirty.length > 0;
}
