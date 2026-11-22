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

## A page runs one WebContainer at a time

`webContainer` in `packages/ui/src/workspace/runners/web-container.ts`, and `Workspace` in `packages/ui/src/workspace/workspace.ts`.

**Context:** The browser allows only one WebContainer per page. A fast switch between examples, or a start screen that boots the first example before the pick, would start a second boot while the first one runs.

**Decision:** A new run boots only after the run before it tore its container down. While the start screen of `Workspace` shows, no run starts and no snapshot loads. A share link skips the start screen. `Workspace` mounts a new run only when an example needs other dependencies or another snapshot. Files with another `package.json`, such as from a share link, mount the snapshot and then install the difference.

**Consequences:** A change must not boot a run before the last one stopped, or start one under the start screen.

## The WebContainer runner restarts the server only when the app can change

`webContainer` in `packages/ui/src/workspace/runners/web-container.ts`.

**Context:** Tokens stay in the tab and reach the app only as environment variables. A failed write leaves files on disk that are not the example's.

**Decision:** A new token or a new Vite config restarts the dev server. A failed write shows in the terminal and does not restart it. The installed dependencies stay when the files keep the `package.json` of the example. The checklist takes the place of the preview while the app starts, so the reader can edit. The docs fixtures run `vite --port 3000`, so the docs pass `port: 3000`: Nitro starts dev workers on other ports first, and they are not the app.

**Consequences:** A token must never reach the files or a share link.

## The render runner keeps the newest render and the scroll position

`render` in `packages/ui/src/workspace/runners/render.ts`.

**Context:** The output runs scripts in a sandboxed frame with its own origin, so a shared link cannot reach the page, and the page cannot read the frame's scroll position. Renders are debounced and can end out of order.

**Decision:** Each edit invalidates older work before the debounce, so a slower render of older files never replaces a newer one. A script in the frame posts its scroll position to the page and goes back to it after each render.

**Consequences:** Removing `sandbox` or giving the frame the page's origin lets a share link run code on the page.

## Workspace starts a desktop-only runner only on desktops

`Workspace` in `packages/ui/src/workspace/workspace.ts`.

**Context:** A WebContainer is too heavy for phones and slow on tablets. Before mount the page cannot know the device.

**Decision:** A desktop runner starts on its own on desktops, on a tap on tablets, and never on phones. Before mount, CSS shows the phone card or the placeholder by width. A runner that any device runs waits only for mount. Copy link keeps the `template` key of the link, so older links open.

**Consequences:** Server rendering must not start a run, and older `?template=` and `#code=` links must keep opening.

## Binary files of an example are read-only assets outside the editor

`webContainer` in `packages/ui/src/workspace/runners/web-container.ts`, and `Workspace` in `packages/ui/src/workspace/workspace.ts`.

**Context:** The editor and the share link hold text. An example can also need binary files, and a lesson can give new files for its next step.

**Decision:** Binary files mount with each boot and never reach the file tree, the editor, or a share link. An example with other assets opens in a new run. A read-only file shows in the editor but the reader cannot edit it, while `useWorkspace().setFile` can still write it. The run opens files through a function, since it starts before the editor state exists, and a path that the run does not have keeps the open file. The open example decides which files are read-only.

**Consequences:** A replace removes only the files it tracks, so assets stay on disk across edits.
