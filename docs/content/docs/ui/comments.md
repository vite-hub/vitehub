---
title: Comments
seo.title: Comments UI components for Vue
description: "Figma-style comments for your own running app: pins, threads, a composer, a side list, and a side panel."
navigation.order: 34
navigation.group: Collaboration
icon: i-lucide-message-circle
---

`CommentLayer` adds Figma-style comments to a page. Press `C`, click a spot, write, and press `Enter`. A numbered pin with your avatar stays there, and the team replies in its thread.

The parts show state and call a transport. They do not store data or check access. The transport talks to the server:

- `createMemoryTransport()` from `vite-hub/comments/testing` is for tests and examples.
- `createRestTransport()` from `vite-hub/comments/client` connects to the [Comments API](/docs/comments/server-api#rest-transport) of the app.
- `createRpcTransport()` from `vite-hub/comments/rpc` connects to the [Comments operations](/docs/comments/operations/server-api#browser-transport) on a development server only.

The built-in live-site overlay uses a different thread and anchor format.

::example{name="CommentComposerExample" height=8}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows, then add the client:

```bash
pnpm add @vite-hub/comments drizzle-orm@1.0.0-rc.6
```

`vite-hub/nuxt` auto-imports the parts. In Vue with Vite, import them from `vite-hub/ui`:

```ts
import { CommentLayer } from "vite-hub/ui";
```

## Usage

```ts
import { createCommentsClient } from "vite-hub/comments/client";
import { createMemoryTransport } from "vite-hub/comments/testing";

const user = { id: "ana", name: "Ana Ruiz" };
const client = createCommentsClient({ transport: createMemoryTransport({ user }), user });
```

```vue
<template>
  <CommentLayer :client="client" :subject="{ kind: 'page', id: '/pricing' }" />
</template>
```

The layer loads the threads of the subject, draws a pin for each, and shows a toolbar with the comment and list buttons.

## How it works

- `C` or the toolbar button starts comment mode. The cursor becomes a speech bubble.
- A click drops a numbered pin with your avatar and opens its composer with focus.
- `Enter` sends. `Shift+Enter` breaks the line.
- `Esc` in an empty composer closes it.
- `Esc` or a click outside a composer with text shakes it, and keeps the focus and text. With reduced motion, the border flashes instead.
- `Esc` outside a composer leaves comment mode.
- Hover a pin to preview its thread. Click it to open the thread, reply, resolve, or reopen.
- Resolved threads have no pin until the Resolved filter is on.
- `?comment=<n>` in the URL opens thread `n` when the page loads.
- Type `@` to mention a person. The client's `users` call finds people. Names that start with your text come first, then names with a later word that starts with it. Accents and case do not count, so `@jose` finds José. People who already wrote in the thread come first. You are never in the list.
- In the mention menu, arrow keys move, `Enter` or `Tab` picks, and `Esc` closes only the menu. `Shift+Enter` still breaks the line.
- When `@` and two or more letters find no one, the menu shows one line instead of a list: "No one by that name can be mentioned here.", or "Could not load people." when the lookup fails. The composer logs the error with `console.warn`. The line is not an option, so `Enter` and `Tab` do not pick it. After a space, the menu stays closed, because the text is then more likely a sentence.
- A posted message shows each mention as a chip. A mention of you has another color.
- Paste, drop, or pick files when the app gives an `upload` function. See [Attachments](#attachments).
- Select text, then press `C`: the comment is about that text.
- A pin drops when the pointer goes up without moving. A touch that scrolls drops nothing.
- In comment mode, `Enter` starts a comment on the focused element. The toolbar button "Comment on page" comments on the whole page.
- A draft pin has no number. The server gives it one on send.
- A drag in comment mode draws an area, with its corners and size while the drag lasts. The comment is about that area.
- With `placement="margin"`, every thread is a card in a column on the right edge of the screen, level with its pin. Click a card or its pin to open the thread in that card and reply there. A new comment is written there too. On a screen narrower than 900px, threads open beside their pins.
- A thread opens in a small card: 340px wide, with a small corner that points at its pin, 14px text, tight rows, and Edit and Delete over the name's row. Set `size="md"` for the larger thread of a panel.
- The card opens under its pin and to the right. Near the right edge it opens to the left, and near the bottom it opens above the pin. The browser picks the side from the card's real size with [CSS anchor positioning](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_anchor_positioning). A browser without it guesses from a 360 by 420 px card.

An anchor stays on its element when the layout changes. When the element is gone, ambiguous, or no longer holds the quoted text, the thread is detached: it stays in the list without a pin. A pin also hides while a scroll container clips its element. See [Anchors](#anchors).

## Composition

```text
CommentLayer
├── CommentPin (one per thread, and one for the draft)
│   └── hover: CommentThread (preview)
│   └── open: CommentThread
│       ├── CommentReply (one per message)
│       └── CommentComposer (variant="reply")
├── CommentComposer (the new comment)
├── CommentToolbar
└── CommentList
    └── CommentFilters

CommentPanel
├── the list of threads, with Open and Resolved
├── CommentThread (navigation="back")
└── CommentComposer (a comment on the whole page)
```

Every part has a `data-slot`, as in shadcn/ui: `comment-layer`, `comment-pin`, `comment-thread`, `comment-reply`, `comment-composer`, `comment-selection-bar`, `comment-mention`, `comment-list`, `comment-filters`, `comment-toolbar`, and `comment-panel`. The default styles sit in the `components` layer of `vite-hub/ui/styles.css`, so utility classes override them.

## Build your own layout

`CommentLayer` renders the toolbar and the list. To place the parts yourself, use the default slot. It receives the `comments` state:

```vue
<template>
  <CommentLayer :client="client" :subject="subject">
    <template #default="{ comments }">
      <CommentToolbar :comments="comments" :people="people" />
      <CommentList :comments="comments" />
    </template>
  </CommentLayer>
</template>
```

Without the layer, call `useComments()` from `vite-hub/ui/headless`. It needs no Nuxt UI. Pass the state it returns as the `comments` prop:

```ts fragment
import { useComments } from "vite-hub/ui/headless";

const comments = useComments({ client, subject: { kind: "page", id: "/pricing" } });
comments.pageThreads.value; // The threads of this page, after the filters.
comments.toggle(); // Comment mode.
comments.startDraft({ x: 120, y: 80 }); // Start a comment on a point.
comments.startDraft(element, { area, files: [screenshot] }); // Start one on an area, with a file in its box.
await comments.create({ body: "Looks good" }); // A comment on the whole page.
comments.people.value; // The people that the state knows, for mention names.
```

| Option | Description |
| --- | --- |
| `client` | The `CommentsClient`. Required. |
| `subject` | What the threads are about. A value, ref, or getter. Required. |
| `user` | The signed-in user. Defaults to `client.user`. |
| `root` | Where to look up anchors. Defaults to the document. |
| `param` | The query parameter of the deep link. Default `"comment"`. |
| `hotkey` | The key of comment mode. Default `"c"`. `false` turns it off. |
| `ignore` | Elements anchors skip. Defaults to the comment UI. |
| `uiRoot` | The document or shadow root that holds the comment UI, where composers with text are found. Defaults to the document. |
| `subjectUrl` | The page URL of a subject, for thread links. Page subjects use their id as the path. Other subjects link to the current page unless you give it. |
| `autoStart` | Load threads and listen for keys on mount. Default `true`. When `false`, call `start()` yourself. |
| `can` | What the user may do in a thread. See [Permissions](#permissions). |
| `visibility` | `"all"` or `"hidden"`. Default `"all"`. Pass a ref to keep the reader's choice. See [Hide comments](#hide-comments). |
| `flashMs` | How long a comment just sent shows while comments are hidden. The time stops while the reader points at or focuses its pin. Default `2500`. |

## Hide comments

A reader can hide the comments on the page and still write them. Set `visibility` to `"hidden"`. Pins, areas, and highlights then show only:

- the open thread, such as one opened from the list,
- the comment being written,
- a comment or reply just sent, for `flashMs`. Like a toast, the time stops while the reader points at or focuses its pin. Then it pops out: it shrinks and fades in 130 ms, or goes at once under `prefers-reduced-motion`.

Writing or opening a comment never changes `visibility`. Pass a ref to keep the choice, such as one saved in `localStorage`:

```ts fragment
import { useComments } from "vite-hub/ui/headless";
import { ref, watch } from "vue";

const visibility = ref(localStorage.getItem("comments") === "hidden" ? "hidden" : "all");
watch(visibility, (value) => localStorage.setItem("comments", value));

const comments = useComments({ client, subject, visibility });
comments.shown.value; // The ids of the threads of this page that get a pin.
comments.leaving.value; // The ids that just stopped showing, for their pop-out.
comments.flash(id); // Show a thread for a moment. send(), create(), and reply() do it.
```

`CommentPanel` keeps its selected thread’s page marks visible while comments are hidden, without opening a page popover. Returning to the list or unmounting the panel releases that exception. Custom panels can call `const release = comments.retainMark(id)` and call `release()` when they close or switch threads; active flashes keep their own timers.

`CommentLayer` follows the state: a pin that stops showing keeps its place for `commentLeaveMs` (130 ms) with `data-leaving="true"`. The ViteHub pill has an eye next to **Comments** for people who may comment, and keeps the choice in this browser.

To draw marks somewhere else, such as in a frame, use `createCommentVisibility()`. It has no framework, so a page can keep one and send its `only` list to the frame:

```ts fragment
import { createCommentVisibility } from "vite-hub/ui/headless";

const visibility = createCommentVisibility({ visibility: "hidden", flashMs: 2500 });
visibility.subscribe(() => frame.postMessage({ only: visibility.only, leaving: visibility.leaving }));
visibility.open(threadId); // The open thread shows. open(null) closes it.
visibility.flash(sent.id); // A comment just sent shows for flashMs.
visibility.hover(sent.id); // The time stops while the reader is on its pin. hover(null) when the reader leaves.
visibility.set("all"); // Every comment shows again.
visibility.stop(); // Clears the timers.
```

`only` lists the ids that still show while comments are hidden, and is empty while all show. `leaving` lists the ids that stopped showing in the last `commentLeaveMs`. Import `commentLeaveMs` from `vite-hub/ui/headless` to time a pop-out you draw yourself. `isShown(id)` answers for one id.

## Side panel

`CommentPanel` shows all comments of a page in one surface, like the side panel of a review tool. It lists threads with Open and Resolved filters. Click a thread to open it in the panel. Back returns to the list with focus on that thread. The box at the bottom comments on the whole page.

::example{name="CommentPanelExample" height=8}
::

Inside `CommentLayer`, the panel uses the layer's state. Put it in the layer's slot to replace the toolbar and list:

```vue
<template>
  <CommentLayer :client="client" :subject="subject">
    <aside class="fixed inset-y-0 right-0 w-80">
      <CommentPanel />
    </aside>
  </CommentLayer>
</template>
```

Without a layer, give it a `client` and `subject`, or a `comments` state.

- `variant="docked"` fills its container, such as a side column.
- `variant="floating"` is a card with a border and shadow. Place it with a class.
- `v-model:thread` opens a thread from your code. `v-model:status` keeps the filter.

The panel keeps its own open thread. A click outside does not close it, because the panel stays on screen.

Each row shows the number, author, start of the first message as plain text, and facts such as the reply count. The `preview` slot replaces the text, and the `row` slot replaces the whole row. Both get `{ thread, text }`, where `text` is the default row text. Render `text` for rows you don't change. To group threads under headings, give `group` a function that returns a thread's heading, or `undefined` for none. Threads without a heading come first, then each group in order of first appearance. The `group-header` slot gets `{ group, threads }`:

```vue
<template>
  <CommentPanel :group="(thread) => (thread.createdAt < publishedAt ? 'From earlier versions' : undefined)">
    <template #preview="{ thread, text }">
      <SuggestionPreview v-if="thread.metadata?.suggestion" :thread="thread" />
      <template v-else>{{ text }}</template>
    </template>
  </CommentPanel>
</template>
```

## Permissions

A thread shows Resolve, Reopen, Edit, Delete, and the reply box only to users who may use them. By default, a signed-in user may reply to and resolve any thread, and edit and delete their own messages. A reader without a user gets no controls. Give `useComments()` a `can` function with your own rules, and every part follows them:

```ts fragment
const comments = useComments({
  client,
  subject,
  // `action` is "reply", "resolve", "edit", or "delete". `message` is set for "edit" and "delete".
  can: (action, { thread, message }) => {
    if (action === "resolve") return isManager.value || thread.author.id === me.value.id;
    if (action === "delete") return isManager.value || message?.author.id === me.value.id;
    return action === "reply" || message?.author.id === me.value.id;
  },
});
```

`CommentLayer`, `CommentPanel`, and `CommentThread` also take a `can` prop, which wins over the state. `readOnly` hides every control.

> [!WARNING]
> These rules only hide controls. The server must still check each request.

## Mentions

A composer finds people from, in order:

1. The `users` prop.
2. The comments state of the nearest `CommentLayer`, `CommentPanel`, or `provideComments()`. It calls the client's `users`.
3. The `people` prop.

So inside a layer or panel, mentions work with no props. Pass `participants`, the ids of people in the conversation, to show them first. A thread passes its authors' ids.

A posted message shows `@Name` as a `comment-mention` chip for each id in `message.mentions`. The name comes from the part's `people` prop, or from people the comments state knows: the user, thread authors, and people that `users` found. The signed-in user's chip has `data-self="true"`. Code spans and code blocks keep `@` as text.

## Attachments

A composer takes files from paste, drop, and the file button. It sends them as `File` objects in `submit`: `{ body, mentions, files }`. It does not upload them.

- `attachments: false` turns the file button off. An edit never has files.
- `accept` limits the file types, such as `image/*`.
- A new comment needs text unless you set `allowEmpty`. A reply can send files without text.
- `v-model:files` lets the parent clear the files after a send.
- In the box, the pictures sit in one stack beside the text, with their count. Hover, focus, or a tap fans them out above the box, where each one opens full size and has a round Remove button. A new picture comes out of the text for a paste, the box for a drop, and the attach button for a pick. Other files show their name.

`CommentThread` passes the files to `onReply` as the third argument. `CommentLayer` and `CommentPanel` accept an `upload` function that stores the files and returns their keys, such as Blob keys. They send the keys as the message `attachments`, even when the client has an outbox.

If the server accepts raw file uploads, set `queue-files` on the layer or panel with a client [outbox](/docs/comments/offline). The outbox saves the files with the comment and the transport uploads them when it sends. An `upload` callback takes precedence if both are set. The outbox alone does not enable file controls.

Transports accept attachment keys by default, including `createRestTransport()` and `createRpcTransport()`. A transport that cannot can set `supportsAttachments: false`. The layer and panel then disable file controls, even with `upload`.

```vue
<script setup lang="ts">
async function upload(files: File[]): Promise<string[]> {
  const form = new FormData();
  for (const file of files) form.append("file", file);
  return await $fetch<string[]>("/api/uploads", { method: "POST", body: form });
}
</script>

<template>
  <CommentPanel :upload="upload" :attachment-url="(key) => `/api/uploads/${key}`" accept="image/*" />
</template>
```

`attachmentUrl` turns a key into a URL. With it, the images of a message show as a mosaic, and other files show as link chips. One image keeps its shape, up to 10rem tall. Two split the width, three put the first beside the other two, and four or more show four tiles, the last with how many more. A tile opens its picture full size, from where it is, and the arrow keys step through every picture of the message. Without it, the message shows file names. An attachment counts as an image when its name has an image extension, such as `.png`, or no extension. When the key does not tell, return the media type with the URL:

```ts
// The files that `upload` stored, by key
const uploads = new Map<string, File>();

const attachmentUrl = (key: string) => ({ url: `/api/files/${key}`, name: uploads.get(key)?.name, type: uploads.get(key)?.type });
```

## Waiting and refused comments

With the [outbox](/docs/comments/offline) of `createCommentsClient()`, a new comment or reply shows at once, before the server has it, and its box empties as soon as it is saved. Until the server answers, the thread has `data-pending="true"`, or `data-failed="true"` when the server refused it, and so does each message that waits. A waiting thread has no number yet, so its title is "Comment".

The parts draw no words for it. The `status` slot renders below each waiting message, with what the reader can do:

```vue
<template>
  <CommentLayer :client="client" :subject="{ kind: 'page', id: '/pricing' }">
    <template #status="{ delivery, retry, dismiss }">
      <p v-if="delivery.status === 'failed'">
        {{ delivery.error?.why }}
        <button v-if="retry" @click="retry()">Retry</button>
        <button v-if="dismiss" @click="dismiss()">Discard</button>
      </p>
      <p v-else class="text-muted">Waiting to send</p>
    </template>
  </CommentLayer>
</template>
```

In read-only threads and previews, the slot receives the delivery state but no actions. In a writable thread, `retry` and `edit` require edit permission and `dismiss` requires delete permission for that message.

`comments.outbox` holds the same in code: `queued` and `failures` (computed lists of entries), `delivery(threadId, messageId?)`, and `retry`, `dismiss`, and `edit`.

## Slots

| Part | Slot | Scope | Where it renders |
| --- | --- | --- | --- |
| `CommentThread` | `actions` | `{ thread }` | In the header, before Resolve. |
| `CommentThread` | `anchor` | `{ thread }` | Instead of the selected-text quote. |
| `CommentThread` | `after` | `{ thread }` | Below the messages, above the reply box. |
| `CommentReply` | `body` | `{ message }` | Instead of the Markdown body. |
| `CommentReply` | `attachments` | `{ message }` | Instead of the default attachments. |
| `CommentReply` | `status` | `{ message, delivery, retry, dismiss, edit }` | Below a message that waits in the outbox. Nothing renders without it. |
| `CommentComposer` | `extra` | | Above the text field, such as a suggested-change field. |
| `CommentComposer` | `mention-item` | `{ person, active }` | Each person of the mention menu. |
| `CommentComposer` | `mention-empty` | `{ query, failed }` | The line of the mention menu when it has no one to show. |
| `CommentLayer` | `status` | `{ message, delivery, retry, dismiss, edit }` | Passed on to each thread and hover card. |
| `CommentPanel`, `CommentList` | `row`, `preview` | `{ thread, text }` | One list row, or its text. `text` is the default row text. |
| `CommentPanel` | `group-header` | `{ group, threads }` | A row group heading. See `group`. |

`CommentThread` passes `body`, `attachments`, `status`, `extra`, `mention-item`, and `mention-empty` to its messages and reply box. `CommentPanel` passes every slot to its thread, and `extra`, `mention-item`, and `mention-empty` to its page box.

::example{name="CommentThreadSlotsExample" height=8}
::

## Themes

The parts use Nuxt UI tokens, such as `--ui-bg`, `--ui-text`, `--ui-border`, and `--ui-primary`. Each element reads them where it renders, so a class on the surface or any element around it themes only that surface. You do not need to set the `--vh-ui-*` tokens too. For a dark panel on a light page, add Nuxt UI's `dark` class:

```vue
<template>
  <aside class="dark">
    <CommentPanel />
  </aside>
</template>
```

Or set the tokens on your own class:

```css
.review-surface {
  --ui-bg: #18181b;
  --ui-bg-elevated: #27272a;
  --ui-text: #e4e4e7;
  --ui-text-highlighted: #fff;
  --ui-border: #3f3f46;
}
```

`--vh-comment-mention-bg` and `--vh-comment-mention-self-bg` set mention chip colors.

The buttons read their icons from the app's icon config: Nuxt UI's `appConfig.ui.icons` for names such as `check` and `close`, and `appConfig.viteHubUI.icons` for `edit`, `delete`, `reopen`, and the toolbar. See [Icons](/docs/ui/installation#icons) for every name.

A saved area is a thin grey line, a tint of the text color, so a page with many areas stays calm. `--vh-ui-comment-mark` sets the color of the area that you draw. It defaults to the focus blue (`--vh-focus`), else the ViteHub blue, so it shows on a dark page and on a white image in it. The pins and areas take their look from [`comment-marks.css`](#comment-marks-without-vue), so `--vh-ui-comment-pin-size` and the other tokens there change them too.

## Comment marks without Vue

`@vite-hub/ui/comment-marks.css` draws the pins, the areas, and the text highlights of comments with plain CSS. `styles.css` includes it, so `CommentLayer` needs nothing more. A page or a frame without Vue loads it on its own and sets data attributes. It works in the page and in a shadow root. Import it from `@vite-hub/ui`, because `?raw` reads the file itself and `vite-hub` has no copy of it:

```ts
import marks from "@vite-hub/ui/comment-marks.css?raw";

const host = document.createElement("page-comments");
const root = host.attachShadow({ mode: "open" });
root.innerHTML = `<style>${marks}</style>`;
// The highlights draw on the page's own text, so the page needs the file too.
document.head.append(Object.assign(document.createElement("style"), { textContent: marks }));
```

| Element | Attributes | Look |
| --- | --- | --- |
| `data-slot="comment-mark-pin"` | `data-shape="point"` or `"round"`, `data-active="true"`, `data-status="resolved"` | A 28px pin. A point is a drop whose small bottom-left corner is the spot. A round pin is for an area or an image. An `<img>` child fills it. |
| `data-slot="comment-mark-area"` | `data-active="true"`, `data-status="resolved"`, `data-draft="true"` | A 1px grey line, 22% of the ink, with no fill. Active is a firmer grey line (45%), resolved is dashed and grey, and a draft is 2px comment blue with a fill. |
| `data-slot="comment-mark-handle"` | `data-corner="top-left"`, `"top-right"`, `"bottom-left"`, or `"bottom-right"` | A round handle on a corner of its area. |
| A pin or an area | `data-leaving="true"` | With CSS alone, it fades in 130ms (`commentLeaveMs`) or hides at once under reduced motion. If the motion layer is installed, the leave effect plays the exit on a copy. Remove the original after `commentLeaveMs`. |

Place a pin with `left` and `top`, and an area with `left`, `top`, `width`, and `height`. Highlight commented text with the CSS Custom Highlight API and these names:

```ts fragment
CSS.highlights.set("vh-comment", new Highlight(...openRanges));
CSS.highlights.set("vh-comment-resolved", new Highlight(...resolvedRanges));
CSS.highlights.set("vh-comment-active", new Highlight(activeRange));
CSS.highlights.set("vh-comment-draft", new Highlight(draftRange));
```

The marks use the ViteHub theme tokens when the page has them, else the theme's own values. Add the `dark` class or `data-theme="dark"` to the root or the shadow host for dark mode. Set `--vh-ui-comment-mark`, `--vh-ui-comment-pin`, `--vh-ui-comment-pin-text`, `--vh-ui-comment-surface`, `--vh-ui-comment-muted`, `--vh-ui-comment-ink` (the text color that highlights and saved areas tint), or `--vh-ui-comment-pin-size` to change one. Inside a scaled layer, set `--vh-comment-zoom` to the inverse of its scale, so the marks keep their size on screen.

## Sizes

`CommentThread` and `CommentComposer` take `size`. The default, `md`, fits a side panel. `sm` fits a small card that floats over the page:

- The thread text is 14px on a 1.5 line, and the rows are tighter.
- The name and the time of a message share a baseline.
- With a mouse, Edit and Delete show over the end of the name's row on hover, so the text uses the full width of the card. A touch screen keeps them in their own column.
- The reply box is shorter and its buttons are 28px. It is a soft filled field with no divider above it, and it shows its edge only while it has the focus, without the 3px halo.
- In `CommentLayer`, the card is 340px wide, its corner nearest the pin is small, and its messages fill the card before they scroll.

A thread passes its size on to its messages, its reply box, and its edit box. For a one-line box for a new comment, use `layout="row"` with `size="sm"`.

::example{name="CommentThreadSizeExample" height=8}
::

```vue
<template>
  <CommentThread :thread :user size="sm" />
  <CommentComposer layout="row" size="sm" :attachments="false" />
</template>
```

`data-size` is on `comment-thread`, `comment-reply`, and `comment-composer`, so a stylesheet can change one size only.

## Selected text

`CommentSelectionBar` is the bar that shows over selected text, as in Drop and the ViteHub pill. It has a Comment button, and a Suggest button with `suggest`. Your page places it, listens for `C` and `E`, and starts the comment. A press on the bar keeps the selection on the page.

```vue
<template>
  <div v-if="selection" class="fixed -translate-x-1/2 -translate-y-full" :style="{ left: `${selection.x}px`, top: `${selection.y - 8}px` }">
    <CommentSelectionBar suggest @comment="commentOnSelection()" @suggest="commentOnSelection(true)" />
  </div>
</template>
```

## Send to an agent

`CommentSend` is the **Send** segment of a comment pill, as in Drop and the ViteHub pill. One click hands the comments that wait for an answer to the member's own agent, such as T3 Code. The button then shows what happens: Sending, Sent, Working with **Open thread**, or Not delivered with **Retry**.

Give it a client from `createCommentSend()`. The client is the state, and the transport talks to your server:

```ts
import { createCommentSend, type CommentSendTransport } from "vite-hub/comments/client";

// Successful Send routes return JSON in the shape that the transport method returns.
const api = async <T>(path: string, method = "GET", body?: object): Promise<T> => {
  const response = await fetch(`/api/send${path}`, {
    method,
    ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Send request failed (${response.status})`);
  return response.json();
};

const transport: CommentSendTransport = {
  status: () => api("/status"),
  startPairing: () => api("/pair", "POST"),
  pollPairing: code => api(`/pair/${code}`),
  allow: (code, selection) => api(`/pair/${code}/allow`, "POST", { selection }),
  cancel: async (code) => {
    const response = await fetch(`/api/send/pair/${code}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Cancel request failed (${response.status})`);
  },
  send: () => api("", "POST"),
};

export const send = createCommentSend(transport);
```

```vue
<template>
  <CommentSend :client="send" />
</template>
```

With Comments `send: true`, the server has these routes already: `createCommentSendTransport({ page })` of `vite-hub/comments/client` is the transport, and the ViteHub pill uses the same one. See [Send comments to your agent](/docs/comments/send).

A member without an agent pairs one in place. **Send 2** copies a setup prompt and says where to paste it. The agent uses the one-time code in the prompt, and the pill asks once: **Allow and send 2**. `×` or `Esc` stops it, and nothing is saved. `startPairing()` returns `count` and `selection`, the threads that the member sees, and `allow(code, selection)` passes them back. When the threads changed, a server that answers `{ status: "changed", count, selection }` keeps the code, and the pill asks again with the new count.

Give your pill a viewport-safe maximum width and let it scroll horizontally if its controls do not fit. `CommentSend` keeps its actions on one row and shortens the setup and confirmation messages on narrow screens.

| State | The pill shows |
| --- | --- |
| `idle` | **Send N**, or **To inbox N** for an agent that picks comments up itself. Nothing when no comment waits. |
| `pairing` | Setup prompt copied, a spinner, and `×`. With `reason`: **Setup code expired** or **That URL isn't `host`**, and **Copy again**. |
| `confirm` | The agent's logo, name, and host, and **Allow and send N**. |
| `sending` | Sending, as wide as **Send N**, so the pill holds still. |
| `sent` | Sent, or In inbox, until the agent reads the send, and for at least 2 seconds. **Send N** comes back beside it when a new comment waits. |
| `working` | Working and **Open thread**. **Send N** comes back beside them when a new comment waits. |
| `failed` | Not delivered and **Retry**. Retry repeats the step that failed: after a failed pairing it pairs again, after a failed Allow it loads the status again, and after a failed send it sends again. |
| `limited` | Limit reached, and the time to try again. |

The client asks `status()` while the agent works. Give the transport `subscribe` to push `working`, `done`, and `count` events instead. In a unit test, give it a fake transport: every state is plain data in `send.state`.

## Anchors

An anchor says where a comment sits. `createAnchor()` makes one from an element, a point, a selection, or `"page"`. `resolveAnchor()` finds it again.

The selector uses the first of `data-comment-id`, `id`, and `data-testid` that matches exactly one element. Else it is a short path from the nearest stable ancestor. Offsets are in thousandths of the element box, so pins follow their element on resize. Add `data-comment-id` to an element that must keep its comments when the markup changes.

Read more in the [`@vite-hub/comments` README](https://github.com/vite-hub/vitehub/tree/main/packages/comments).

## Accessibility

- A pin is a button. Its label has the number, author, and start of the comment, such as "Comment 3 by Ana Ruiz: Make this bigger", and says when the thread is resolved. `aria-expanded` shows if its thread is open.
- An open thread is a `dialog` named "Comment 3". Opening it moves focus into it. Closing it returns focus to its pin, unless the reader moved focus elsewhere.
- The composer has a label. Its box is a `combobox`. While the mention menu is open, the box has `aria-expanded="true"`, `aria-controls`, and `aria-activedescendant`. The menu is a `listbox`. A menu with no one to show is a `status` with one line and no options, so the box keeps `aria-expanded="false"`.
- In `CommentPanel`, threads are buttons in a list. Back moves focus to the thread that was open. The Open and Resolved filters have `aria-pressed`.
- Deleting the first message asks first, because it deletes the thread.
- The toolbar is a `toolbar`. The comment button has `aria-pressed` and `aria-keyshortcuts="C"`.
- The bar over selected text is a `group` named "Selected text". Its buttons have `aria-keyshortcuts`, `C` for Comment and `E` for Suggest.
- The Send segment is a `group` named "Send comments to your agent". Each change of state is read out, such as "Sent." or "Not delivered.", and the focus moves to the new button when the pressed one goes. `Esc` stops pairing. Under `prefers-reduced-motion` the spinner and the Working dot stay still.
- Under `prefers-reduced-motion` the composer does not shake. Its border flashes. A pin that stops showing fades without shrinking.
- A pin that stops showing is `inert` during its pop-out.

## API Reference

### CommentLayer

The page overlay. Renders a `div` with `data-slot="comment-layer"`. Give it a `client` and `subject`, or a `comments` state.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `client` | `CommentsClient` | | The client. Needed without `comments`. |
| `subject` | `CommentSubject` | | What the threads are about. Needed without `comments`. |
| `user` | `CommentUser` | | The signed-in user. Defaults to the client's user. |
| `comments` | `CommentsState` | | A state from `useComments()`, instead of `client` and `subject`. |
| `people` | `AvatarStackPerson[]` | `[]` | People on the page, shown in the toolbar's [Avatar Stack](/docs/ui/avatar-stack). |
| `hotkey` | `string \| false` | `"c"` | The key of comment mode. |
| `readOnly` | `boolean` | `false` | Hide reply, edit, delete, and status controls. |
| `subjectUrl` | `(subject: CommentSubject) => string \| undefined` | | The page URL of a subject, for links of non-page threads. |
| `can` | `(action, { thread, message }) => boolean` | | What the user may do in a thread. Defaults to the state's `can`. See [Permissions](#permissions). |
| `navigate` | `(href: string) => void` | | Opens the page of a listed thread. Defaults to `location.assign`. |
| `upload` | `(files: File[]) => Promise<string[]>` | | Stores files and returns their keys. Takes precedence over `queueFiles`. |
| `queueFiles` | `boolean` | `false` | With an outbox, saves raw files with the comment for later upload. Set only if the server accepts file uploads. |
| `accept` | `string` | | File types the boxes take, such as `image/*`. |
| `attachmentUrl` | `(key: string) => string \| { url, name?, type? } \| undefined` | | The URL of a key, optionally with file name and media type. Images show as thumbnails, other files as links. |
| `placement` | `"pin" \| "margin"` | `"pin"` | Where threads open: beside their pins, or in cards on the right edge of the screen, level with their pins. `"margin"` works as `"pin"` below 900px. |
| `size` | `"sm" \| "md"` | `"sm"` | The size of the thread cards and of the box for a new comment. `"sm"` is the small card: 14px text, tight rows, and Edit and Delete over the name's row. `"md"` is the size of a thread in a panel. |

### CommentPin

Renders a `button` with `data-slot="comment-pin"`, with the author's avatar and the thread number.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `n` | `number` | | The thread number. A draft has none. |
| `author` | `CommentUser` | | Whose avatar shows. |
| `excerpt` | `string` | | The start of the comment, used in the label. |
| `status` | `"open" \| "resolved"` | `"open"` | A resolved pin is gray. |
| `active` | `boolean` | `false` | The thread of this pin is open. |
| `draft` | `boolean` | `false` | The comment is not sent yet. |

#### Events

| Event | Description |
| --- | --- |
| `select` | The pin was clicked. |
| `hover` | The pointer or the focus came to the pin. |
| `leave` | The pointer or the focus left the pin. |

### CommentSelectionBar

The bar over selected text. Renders a `div` with `data-slot="comment-selection-bar"`. Each button has `data-slot="comment-selection-bar-action"` and `data-action="comment"` or `data-action="suggest"`. Inside Nuxt UI's `UApp`, each button has a tooltip with its key. Elsewhere the button has a `title`.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `suggest` | `boolean` | `false` | Show the Suggest button. |
| `side` | `"top" \| "bottom"` | `"top"` | The side of the text that the bar is on. The bar grows from that side. |

#### Events

| Event | Description |
| --- | --- |
| `comment` | Comment was clicked. |
| `suggest` | Suggest was clicked. |

### CommentSend

The Send segment of a comment pill. Renders a `div` with `data-slot="comment-send"` and `data-state` set to the state. Its buttons have `data-action`: `send`, `allow`, `cancel`, `copy-again`, `retry`, and the `open` link. It starts the client when it mounts and stops it when it unmounts. It takes the pill's `--vitehub-pill-*` colors, and else the Nuxt UI tokens around it.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `client` | `CommentSendClient` | Required | The client from `createCommentSend(transport)`. |

### CommentThread

The thread of one pin, as a card. With `preview`, it is the read-only hover card. Renders a `section` with `data-slot="comment-thread"`.

Handlers may return a promise, and the thread waits for it. The reply box clears only after `onReply` succeeds. On failure, the text stays and the error shows. While a reply is sending, the box cannot send again.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `thread` | `CommentThread` | Required | The thread. |
| `user` | `CommentUser` | | The signed-in user, who can edit and delete their messages. |
| `preview` | `boolean` | `false` | A read-only card with the comment and the reply count. |
| `readOnly` | `boolean` | `false` | Show the full thread without reply, edit, delete, or status controls. |
| `can` | `(action, { thread, message }) => boolean` | | What the signed-in user may do: `reply`, `resolve`, `edit`, or `delete`. Defaults to the state's `can`, else [the default rules](#permissions). |
| `busy` | `boolean` | `false` | Show a reply as sending, on top of the thread's own tracking. |
| `error` | `string` | | An error to show, on top of handler errors. |
| `detached` | `boolean` | `false` | The thread's spot is no longer on the page. |
| `people` | `CommentUser[]` | `[]` | People messages may mention, besides thread authors. Their mentions show as chips. |
| `users` | `(query: string) => Promise<CommentUser[]>` | | Finds people for `@mentions`. Defaults to the comments state. |
| `attachments` | `boolean` | `true` | The reply box takes files. |
| `accept` | `string` | | File types the reply box takes. |
| `attachmentUrl` | `(key: string) => string \| { url, name?, type? } \| undefined` | | The URL of a key, optionally with file name and media type. Images show as thumbnails, other files as links. |
| `navigation` | `"close" \| "back"` | `"close"` | `"back"` shows Back at the start of the header instead of Close. Both emit `close`. |
| `dismissible` | `boolean` | `true` | A click outside the thread closes it. Turn it off in a panel. |
| `size` | `"sm" \| "md"` | `"md"` | `sm` is a compact thread for a small floating card. See [Sizes](#sizes). |
| `onReply` | `(body: string, mentions: string[], files: File[]) => void \| Promise<unknown>` | | Sends a reply. |
| `onEdit` | `(messageId: string, body: string, mentions: string[]) => void \| Promise<unknown>` | | Saves an edited message. |
| `onDelete` | `(messageId: string) => void \| Promise<unknown>` | | Deletes a message. Deleting the first message deletes the thread, after a confirmation. |
| `onResolve` | `() => void \| Promise<unknown>` | | Resolve was pressed. |
| `onReopen` | `() => void \| Promise<unknown>` | | Reopen was pressed. |

#### Events

| Event | Description |
| --- | --- |
| `close` | Close or Back was pressed, or the reader clicked outside. |

The component ref exposes `close()`. Call it when a parent dialog or panel wants to close the thread. Like the header button, it checks for unsent replies and edits before it emits `close`.

#### Slots

| Slot | Scope | Description |
| --- | --- | --- |
| `actions` | `{ thread }` | More header buttons, before Resolve. |
| `anchor` | `{ thread }` | What the thread is about. Replaces the selected-text quote. |
| `after` | `{ thread }` | Below the messages, above the reply box. |
| `body`, `attachments` | `{ message }` | Passed on to each `CommentReply`. |
| `status` | `{ message, delivery, retry, dismiss, edit }` | Passed on to each `CommentReply`. |
| `extra`, `mention-item`, `mention-empty` | | Passed on to the reply box. |

### CommentReply

One message of a thread. The first message is the comment, the rest are replies. Its author can edit and delete it. Renders a `div` with `data-slot="comment-reply"`. Its time is a [Relative Time](/docs/ui/relative-time), as is the time of each row in a list. The body is [Markdown](/docs/ui/markdown), with a `comment-mention` chip for each person in `message.mentions`. The edit box closes after `onEdit` succeeds. On failure, it stays open with the text and error.

Edit and Delete show when you give their handlers. An unchanged edit keeps its mention ids, even when a name is unknown. For changed text, pass mentioned people in `people` so the composer can check which names remain.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `message` | `CommentMessage` | Required | The message. |
| `user` | `CommentUser` | | The signed-in user, whose mention chip has `data-self="true"`. Defaults to the state's user. |
| `editable` | `boolean` | `false` | Show Edit when `onEdit` is given. |
| `deletable` | `boolean` | | Show Delete when `onDelete` is given. Defaults to `editable`. |
| `compact` | `boolean` | `false` | Clamp the body to three lines, without actions. |
| `confirmDelete` | `boolean` | `false` | Confirm before Delete. Threads set it on the first message. |
| `size` | `"sm" \| "md"` | `"md"` | `sm` sets 14px text and shows Edit and Delete over the end of the name's row. Threads pass on their size. |
| `people` | `CommentUser[]` | `[]` | People the message may mention, so edits keep their mentions and the body shows chips. |
| `users` | `(query: string) => Promise<CommentUser[]>` | | Finds people for `@mentions` while editing. |
| `attachmentUrl` | `(key: string) => string \| { url, name?, type? } \| undefined` | | The URL of a key, optionally with file name and media type. Images show as thumbnails, other files as links. |
| `onEdit` | `(messageId: string, body: string, mentions: string[]) => void \| Promise<unknown>` | | Saves the edit. |
| `onDelete` | `(messageId: string) => void \| Promise<unknown>` | | Deletes the message. |

#### Slots

| Slot | Scope | Description |
| --- | --- | --- |
| `body` | `{ message }` | Replaces the Markdown body. |
| `attachments` | `{ message }` | Replaces the default attachment list. |
| `status` | `{ message, delivery, retry, dismiss, edit }` | Below the message while it waits in the outbox. `delivery` has `status` (`pending` or `failed`) and `error`. |
| `mention-item` | `{ person, active }` | Passed on to the edit box. |
| `mention-empty` | `{ query, failed }` | Passed on to the edit box. |

### CommentComposer

The box for a new comment, a reply, or an edit. It wraps [Prompt Input](/docs/ui/prompt-input). With `layout="row"` it is one row under a divider: attach, the text, and send. The reply box of a thread and the box at the bottom of a panel use it. When the text of a row box wraps, the text takes the full width and attach and send move to a row under it. The box goes back to one row when the text fits beside the buttons again.

Renders a `div` with `data-slot="comment-composer"`, `data-layout`, `data-size`, and `data-frame`. It has `data-multiline` while the text of a row box wraps, `data-shake` while it shakes, `data-dirty` while it has text or files, and `data-dragging` while files are dragged over it.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `modelValue` | `string` | `""` | The text. Use `v-model`. |
| `mentions` | `string[]` | `[]` | The ids of the people mentioned. Use `v-model:mentions`. |
| `files` | `File[]` | | The attached files. Use `v-model:files` to clear them after a send. Without it, the box keeps its own list. |
| `user` | `CommentUser` | | Who writes. They are not in the mention menu. |
| `variant` | `"comment" \| "reply" \| "edit"` | `"comment"` | Sets the label and placeholder. |
| `placeholder` | `string` | | Defaults to the variant placeholder. |
| `busy` | `boolean` | `false` | A send is running. The box keeps its text and cannot send again. |
| `error` | `string` | | Why the last send failed. |
| `autofocus` | `boolean` | `true` | Focus the box when it appears. |
| `guard` | `boolean` | `true` | A click outside closes an empty box and shakes a box with text. Turn it off when the parent decides. |
| `people` | `CommentUser[]` | `[]` | People the text may mention. A mention is sent only while its `@name` is in the text, so deleting the name drops it. |
| `participants` | `string[]` | `[]` | Ids of people in the conversation, shown first in the mention menu. |
| `users` | `(query: string) => Promise<CommentUser[]>` | | Finds people for `@mentions`. Defaults to the comments state, else `people`. See [Mentions](#mentions). |
| `attachments` | `boolean` | `true` | Take files from paste, drop, and the file button. Edits never take files. |
| `accept` | `string` | | File types to take, like a file input's `accept`. |
| `allowEmpty` | `boolean` | | Send files without text. Defaults to on for a reply and off for a new comment. |
| `layout` | `"box" \| "row"` | `"box"` | `box` is a bordered field. `row` is one line that shows its edge only while it has the focus, for a box inside a card. |
| `size` | `"sm" \| "md"` | `"md"` | `sm` is a shorter field with smaller buttons, and its focus edge has no halo. See [Sizes](#sizes). |
| `frame` | `"field" \| "none"` | `"field"` | `none` is for a box whose parent is its frame, such as a bubble: the field shows no edge on focus, so the parent shows the focus. The box for a new comment on `CommentLayer` uses it. |

#### Events

| Event | Description |
| --- | --- |
| `update:modelValue` | Text changed. Gets the text. |
| `update:mentions` | Mentions changed. Gets their ids. |
| `update:files` | Files changed. Gets the files. |
| `submit` | `Enter` was pressed with text, or with files when allowed. Gets `{ body, mentions, files }`. |
| `cancel` | `Esc` in an empty box, or a click outside it. |

#### Slots

| Slot | Scope | Description |
| --- | --- | --- |
| `extra` | | Above the text field, such as a suggested-change field. |
| `mention-item` | `{ person, active }` | One person of the mention menu. `active` is true for the person the arrow keys are on. |
| `mention-empty` | `{ query, failed }` | The line of the mention menu when it has no one to show. `query` is the text after `@`. `failed` is true when the lookup failed. |

The component exposes `focus()` and `shake()`.

### CommentPanel

The thread list, one thread, and a page box in one surface. Renders a `section` with `data-slot="comment-panel"`, `data-variant`, and `data-view` (`list` or `thread`). Give it a `client` and `subject`, a `comments` state, or put it inside `CommentLayer`.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | | A state from `useComments()`. Defaults to the state of the nearest `CommentLayer` or `provideComments()`. |
| `client` | `CommentsClient` | | The client, for a panel without a layer. Use with `subject`. |
| `subject` | `CommentSubject` | | What the threads are about, with `client`. |
| `user` | `CommentUser` | | The signed-in user, with `client`. Defaults to the client's user. |
| `variant` | `"docked" \| "floating"` | `"docked"` | `docked` fills its container. `floating` is a card with border and shadow. |
| `thread` | `string \| null` | | The open thread id. Use `v-model:thread`. Without it, the panel keeps its own. |
| `status` | `"open" \| "resolved"` | | Which threads the list shows. Use `v-model:status`. Defaults to `"open"`. |
| `title` | `string` | `"Comments"` | The heading of the list. |
| `readOnly` | `boolean` | `false` | Hide the page box and all reply, edit, delete, and status controls. |
| `can` | `(action, { thread, message }) => boolean` | | What the user may do in a thread. Defaults to the state's `can`. |
| `upload` | `(files: File[]) => Promise<string[]>` | | Stores files and returns their keys. Takes precedence over `queueFiles`. |
| `queueFiles` | `boolean` | `false` | With an outbox, saves raw files with the comment for later upload. Set only if the server accepts file uploads. |
| `accept` | `string` | | File types the boxes take. |
| `attachmentUrl` | `(key: string) => string \| { url, name?, type? } \| undefined` | | The URL of a key, optionally with file name and media type. Images show as thumbnails, other files as links. |
| `allowEmpty` | `boolean` | `false` | Allow a new page comment with files and no text. |
| `people` | `CommentUser[]` | `[]` | People messages may mention, besides the people the state knows. |
| `group` | `(thread: CommentThread) => string \| undefined` | | The group heading of a row. Rows without a group come first. |

#### Events

| Event | Description |
| --- | --- |
| `update:thread` | A thread opened, or Back was pressed. Gets the id or `null`. |
| `update:status` | Open or Resolved was pressed. Gets the status. |
| `select` | A listed thread was clicked. Gets the thread. |

#### Slots

Every slot of [CommentThread](#commentthread). `extra`, `mention-item`, and `mention-empty` also go to the page box.

| Slot | Scope | Description |
| --- | --- | --- |
| `row` | `{ thread, text }` | Replaces the number, avatar, text, and facts of one row. |
| `preview` | `{ thread, text }` | The text of one row. Render `text` to keep the default. |
| `group-header` | `{ group, threads }` | A row group heading. Replaces the text `group` returned. |
| `list-actions` | | Buttons at the end of the list's top row, such as Close. |

### CommentToolbar

The comment, "Comment on page", and list buttons, and the people on the page. Its default slot adds your tools after them, such as an Edit link. Renders a `div` with `data-slot="comment-toolbar"`.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | | The state from `useComments()`. Defaults to the layer's state. |
| `people` | `AvatarStackPerson[]` | `[]` | The people on the page. |

### CommentList

The side list of threads. Renders a `section` with `data-slot="comment-list"`. It lists threads of this page or every page, with the filters. Each row links to the thread's page with `?comment=<n>`.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | | The state from `useComments()`. Defaults to the layer's state. |
| `navigate` | `(href: string) => void` | | Opens the page of a thread on another page. Defaults to `location.assign`. |

#### Events

| Event | Description |
| --- | --- |
| `select` | A row was clicked. Gets the thread. |

#### Slots

| Slot | Scope | Description |
| --- | --- | --- |
| `row` | `{ thread, text }` | Replaces the number, avatar, text, and facts of one row. |
| `preview` | `{ thread, text }` | The text of one row. Render `text` to keep the default. |

### CommentFilters

Open, Resolved, and Mine toggles. Renders a `div` with `data-slot="comment-filters"`. The filters apply to the pins and the list.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `comments` | `CommentsState` | | The state from `useComments()`. Defaults to the layer's state. |

## Related

- [Avatar Stack](/docs/ui/avatar-stack) shows who is on the page.
- [Prompt Input](/docs/ui/prompt-input) is the composer's box.
- [Attachment](/docs/ui/attachment) shows the files of a message.
- [Markdown](/docs/ui/markdown) renders the messages.
- [Relative Time](/docs/ui/relative-time) shows when each comment was written.
