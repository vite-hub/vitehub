# UI decisions

## WorkspaceSidebar gives focus back only when focus was in the panel

`WorkspaceSidebar` in `packages/ui/src/workspace/workspace-sidebar.ts`.

**Context:** The sidebar closes on Escape, on its button, and on a click outside. After a click outside, the reader already put focus where they want it. A sidebar can also mount open, so it has no earlier focus to restore.

**Decision:** On close, focus moves only when it was in the panel or on the body. It goes to the element that had focus before the open, or to the button with `aria-controls` set to the panel id when there is none. A sidebar that mounts open takes focus on mount, since the `open` watcher runs only on a change.

**Consequences:** A change must not take focus away from a click outside, and must keep focus on the page when the sidebar mounted open and then closes.

## The workspace parts checks compare rects with the prototype at 1280x760

`packages/ui/test/browser/workspace-parts/checks/bar.mjs` and `checks/start.mjs`.

**Context:** The rects come from the prototype (`v-playground-examples-menu` and `v-playground-start-screen`) at 1280x760, with its menu and sidebar open. The prototype and the check page do not load the same font.

**Decision:** The checks compare only rects that do not depend on the width of text.

**Consequences:** A new check that measures a text-sized rect fails for font reasons, not for a layout change.
