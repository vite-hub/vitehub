/**
 * Styles of the overlay's own pieces. The comment parts bring theirs from `@vite-hub/ui/styles.css`. All of them live
 * in shadow roots, so the host page's CSS does not reach them: the overlay, its toolbar in the page tools pill, and
 * the list in the pill's window. The overlay uses the system sans-serif font, as Drop does, and follows the page's light or dark scheme. It sets the Nuxt UI
 * tokens that the parts read, because their fallbacks follow `currentColor`, which is white inside a pin.
 */
export const overlayStyles = `
:host {
  all: initial;
  --ui-bg: #fff; --ui-bg-elevated: #f5f5f5; --ui-bg-accented: #e5e5e5; --ui-bg-muted: #fafafa; --ui-border: #e5e5e5;
  --ui-text: #404040; --ui-text-muted: #737373; --ui-text-highlighted: #171717; --ui-text-inverted: #fff; --ui-primary: #2563eb;
}
:host(.dark) {
  --ui-bg: #171717; --ui-bg-elevated: #262626; --ui-bg-accented: #404040; --ui-bg-muted: #1f1f1f; --ui-border: rgb(255 255 255 / 12%);
  --ui-text: #e5e5e5; --ui-text-muted: #a3a3a3; --ui-text-highlighted: #fafafa; --ui-text-inverted: #171717; --ui-primary: #60a5fa;
}
.root { position: fixed; inset: 0; pointer-events: none; z-index: 2147482999; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.root > * { pointer-events: auto; }
/* The comment layer covers the page. Only its parts and the comment mode overlay take the pointer, as @vite-hub/ui styles them. */
.root > .cursors, .root > .outlines, .root > .areas, .root > [data-slot="comment-layer"] { pointer-events: none; }
.avatar { width: 24px; height: 24px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #18181b; overflow: hidden; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }

.cursor { position: fixed; transform: translate(-2px, -2px); transition: left 80ms linear, top 80ms linear; }
.cursor svg { display: block; filter: drop-shadow(0 1px 1px rgb(0 0 0 / .25)); }
.cursor span { display: inline-block; margin: 2px 0 0 12px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; color: #18181b; white-space: nowrap; box-shadow: 0 1px 3px rgb(0 0 0 / .2); }

.outline { position: fixed; border: 2px solid var(--vh-primary); border-radius: 4px; }
.outline[data-kind="draft"] { border-style: dashed; border-color: #f59e0b; }
.tag { position: fixed; transform: translateY(-100%); padding: 2px 6px; border-radius: 4px 4px 0 0; background: #f59e0b; color: #18181b; font-size: 11px; font-weight: 600; }
.outline[data-kind="hover"] + .tag { background: var(--vh-primary); color: #fff; }

.card { position: fixed; left: 50%; bottom: 68px; translate: -50% 0; z-index: 2147483001; width: min(320px, calc(100vw - 32px)); display: grid; gap: 8px; padding: 12px; background: var(--vh-bg); color: var(--vh-text); border: 1px solid var(--vh-border); border-radius: calc(var(--vh-radius) * 1.5); box-shadow: 0 8px 24px rgb(0 0 0 / .16); font-size: 13px; }
.card label { display: grid; gap: 4px; font-weight: 500; }
.card input { font: inherit; color: inherit; background: var(--vh-bg-elevated); border: 1px solid var(--vh-border); border-radius: var(--vh-radius); padding: 6px 8px; }
.card input:focus-visible { outline: 2px solid var(--vh-ring); outline-offset: 0; }
@media (pointer: coarse) { .card input { font-size: 16px; } }
.card .row { display: flex; justify-content: flex-end; gap: 6px; }

.toast { position: fixed; left: 50%; bottom: 68px; translate: -50% 0; z-index: 2147483001; max-width: min(520px, calc(100vw - 32px)); padding: 8px 8px 8px 14px; background: var(--vh-bg); color: var(--vh-text); border: 1px solid var(--vh-border); border-radius: 12px; box-shadow: 0 8px 24px -6px rgb(0 0 0 / .16); display: flex; gap: 12px; align-items: center; font-size: 13px; text-wrap: pretty; }
.toast[data-kind="error"] { border-color: color-mix(in oklab, var(--vh-error) 45%, transparent); }
.toast a { color: var(--vh-primary); font-weight: 500; white-space: nowrap; text-underline-offset: 3px; }
.toast > span { padding: 4px 0; }

/*
 * Drop's comment marks. A pin is the author's avatar in a 28px drop whose sharp corner points at the spot: in the gutter
 * right of a quote's block, level with its last line; at the corner of an area; at the point of a click. --pin-x and --pin-y
 * place the pin's corner from the spot, and the card opens beside the pin, level with it, or under it near the right
 * edge of the screen.
 */
[data-slot="comment-layer-item"] { --pin-x: 0px; --pin-y: -28px; }
[data-slot="comment-layer-item"][data-kind="text"] { --pin-x: 0px; --pin-y: -14px; }
[data-slot="comment-layer-item"]:is([data-kind="area"], [data-kind="image"]) { --pin-x: -14px; --pin-y: -14px; }
[data-slot="comment-pin"] {
  width: 28px; height: 28px; border: 0; border-radius: 14px 14px 14px 4px; touch-action: manipulation;
  background: var(--ui-text-highlighted); color: var(--ui-text-inverted);
  box-shadow: 0 0 0 2px var(--ui-bg), 0 2px 8px rgb(0 0 0 / .18);
  transform: translate(var(--pin-x), var(--pin-y)); transform-origin: 0 100%;
  transition: scale 120ms ease-out, opacity 150ms ease-out;
}
[data-kind="text"] > [data-slot="comment-pin"] { transform-origin: 0 50%; }
:is([data-kind="area"], [data-kind="image"]) > [data-slot="comment-pin"] { border-radius: 14px; transform-origin: 50% 50%; }
/* The pin stays 28px, and its hit area is 44px. */
[data-slot="comment-pin"]::before { content: ""; position: absolute; inset: -8px; border-radius: 50%; }
[data-slot="comment-pin"]:is(:hover, :focus-visible, [data-active="true"]) { scale: 1.06; }
/* A tap must not leave the pin grown, so only a fine pointer grows it on hover. */
@media not ((hover: hover) and (pointer: fine)) { [data-slot="comment-pin"]:hover:not(:focus-visible, [data-active="true"]) { scale: none; } }
[data-slot="comment-pin"] [data-slot="avatar-stack"] { --vh-avatar-size: 28px; }
[data-slot="comment-pin"] [data-slot="avatar-stack"] { display: block; }
[data-slot="comment-pin"] [data-slot="avatar-stack-item"] {
  border-radius: inherit; box-shadow: none; background: none; color: inherit; font: 600 11px/28px ui-sans-serif, system-ui, sans-serif; letter-spacing: .02em;
}
/* A new comment is one small surface, as in Drop: the line grows with the text, with the attach and send buttons beside it. */
[data-draft="true"] [data-slot="comment-composer"] { padding: 4px; }
[data-draft="true"] [data-slot="prompt-input-group"] { flex-flow: row wrap; align-items: flex-end; border: 0; box-shadow: none; background: none; }
[data-draft="true"] [data-slot="prompt-input-attachments"] { flex-basis: 100%; }
[data-draft="true"] [data-slot="prompt-input-textarea"] { flex: 1; min-width: 0; min-height: 2.25rem; padding: .5rem .25rem .375rem .625rem; }
[data-draft="true"] [data-slot="prompt-input-toolbar"] { padding: .25rem; }
[data-slot="comment-pin-number"] { display: none; }
[data-slot="comment-pin"][data-status="resolved"] { opacity: .55; filter: grayscale(1); }
[data-slot="comment-pin"][data-draft="true"] { outline: none; }

/*
 * --popover-width is the width the card wants. On a narrow screen it is the screen less 12px each side, and the card
 * moves toward the middle so that no part of it goes off screen. --vh-comment-x is the x of the spot on the screen.
 */
[data-slot="comment-layer-popover"] {
  --popover-width: 340px; --popover-room: min(var(--popover-width), calc(100vw - 24px));
  left: min(calc(var(--pin-x) + 36px), calc(100vw - 12px - var(--popover-room) - var(--vh-comment-x, 0px)));
  top: var(--pin-y); width: var(--popover-room); max-width: none;
  border-radius: 6px 16px 16px 16px; box-shadow: 0 8px 24px rgb(0 0 0 / .16), 0 1px 3px rgb(0 0 0 / .08);
  transform-origin: 0 14px; animation: vitehub-comments-pop 160ms cubic-bezier(.23, 1, .32, 1);
}
[data-draft="true"] > [data-slot="comment-layer-popover"] { --popover-width: 300px; border-radius: 6px 18px 18px 18px; }
[data-slot="comment-layer-popover"][data-preview="true"] { --popover-width: 18rem; animation: none; }
[data-slot="comment-layer-item"][data-flip-x="true"] > [data-slot="comment-layer-popover"] {
  left: auto; right: clamp(calc(var(--vh-comment-x, 0px) + 12px - 100vw), calc(-28px - var(--pin-x)), calc(var(--vh-comment-x, 100vw) - var(--popover-room) - 12px)); top: calc(var(--pin-y) + 36px); border-radius: 16px 6px 16px 16px; transform-origin: 100% 0;
}
[data-slot="comment-layer-item"][data-flip-y="true"] > [data-slot="comment-layer-popover"] {
  top: auto; bottom: calc(-28px - var(--pin-y)); border-radius: 16px 16px 16px 6px; transform-origin: 0 100%;
}
[data-slot="comment-layer-item"][data-flip-x="true"][data-flip-y="true"] > [data-slot="comment-layer-popover"] {
  bottom: calc(8px - var(--pin-y)); border-radius: 16px 16px 6px 16px; transform-origin: 100% 100%;
}
[data-slot="comment-layer-item"][data-above="true"] > [data-slot="comment-layer-popover"] {
  top: auto; bottom: calc(var(--pin-y) * -1 + 4px); border-radius: 16px 16px 16px 6px; transform-origin: 0 100%;
}
[data-slot="comment-layer-popover"][data-floating="true"] { border-radius: 16px; }

/*
 * On a touch screen the small buttons of a card, such as Resolve and Close, take a 44px hit area. The box's own toolbar
 * already has one, and an attachment's trigger covers its attachment.
 */
[data-slot="comment-layer-popover"] button { touch-action: manipulation; }
@media (pointer: coarse) {
  [data-slot="comment-layer-popover"] button:not([data-slot="attachment-trigger"], [data-slot="prompt-input-toolbar"] button) { position: relative; }
  [data-slot="comment-layer-popover"] button:not([data-slot="attachment-trigger"], [data-slot="prompt-input-toolbar"] button)::after {
    content: ""; position: absolute; inset: min(0px, calc((100% - 44px) / 2));
  }
}

/* The area that a drag in comment mode draws. The areas of threads are in areaStyles, under the page's floating controls. */
[data-slot="comment-layer-area"] {
  position: fixed; box-sizing: border-box; border: 1.5px solid var(--ui-text-highlighted); border-radius: 3px;
  background: color-mix(in oklab, var(--ui-text-highlighted) 14%, transparent); pointer-events: none;
}

/* The bar over selected text: the pill's dark glass on a light page, its light twin on a dark one. */
.selection-bar {
  position: fixed; z-index: 2147483001; translate: -50% -100%; display: flex; gap: 4px; padding: 4px;
  border: 1px solid rgb(255 255 255 / 12%); border-radius: 12px; background: rgb(17 17 17 / 92%);
  box-shadow: 0 8px 24px rgb(0 0 0 / 25%); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  font: 500 12px/1 ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased;
  --bar-text: #d4d4d4; --bar-strong: #fafafa; --bar-hover: rgb(255 255 255 / 8%);
  transform-origin: 50% 100%; animation: vitehub-comments-pop 140ms cubic-bezier(.23, 1, .32, 1);
}
.selection-bar[data-below="true"] { translate: -50% 0; transform-origin: 50% 0; }
:host(.dark) .selection-bar {
  border-color: rgb(0 0 0 / 10%); background: rgb(250 250 250 / 94%); box-shadow: 0 8px 24px rgb(0 0 0 / 40%);
  --bar-text: #404040; --bar-strong: #0a0a0a; --bar-hover: rgb(0 0 0 / 6%);
}
.selection-bar button {
  all: unset; position: relative; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
  border-radius: 8px; color: var(--bar-text); cursor: pointer; touch-action: manipulation; white-space: nowrap;
  transition: background-color 150ms, color 150ms, scale 150ms; transition-timing-function: cubic-bezier(.23, 1, .32, 1);
}
.selection-bar button::before { content: ""; position: absolute; inset: -9px -2px; }
@media (hover: hover) and (pointer: fine) { .selection-bar button:hover { background: var(--bar-hover); color: var(--bar-strong); } }
.selection-bar button:active { scale: .96; }
.selection-bar button:focus-visible { outline: 2px solid var(--bar-strong); outline-offset: 1px; }

@keyframes vitehub-comments-pop { from { opacity: 0; scale: .96; } }
@keyframes vitehub-comments-enter { from { opacity: 0; transform: translateY(4px); } }
.toast, .card { animation: vitehub-comments-enter 180ms cubic-bezier(.23, 1, .32, 1); }
@media (prefers-reduced-motion: reduce) {
  .toast, .card, .selection-bar, [data-slot="comment-layer-popover"] { animation: none; }
  [data-slot="comment-pin"] { transition: none; }
  .selection-bar button { transition-property: background-color, color; }
  .selection-bar button:active { scale: none; }
  .cursor { transition: none; }
}
`

/**
 * The list in the pill's window. The window opens from the dark pill, so the list is dark on light and dark pages,
 * like the comments panel of Drop: it sets the Nuxt UI tokens that the parts read.
 */
export const panelStyles = `
:host {
  all: initial; display: block; height: 100%; color-scheme: dark;
  --ui-bg: #0a0a0a; --ui-bg-elevated: #171717; --ui-bg-accented: #262626; --ui-bg-muted: #171717; --ui-border: rgb(255 255 255 / 12%);
  --ui-text: #e5e5e5; --ui-text-muted: #a3a3a3; --ui-text-highlighted: #fafafa; --ui-text-inverted: #0a0a0a; --ui-primary: #60a5fa;
}
.panel-root { height: 100%; }
[data-slot="comment-panel"] { height: 100%; background: var(--vh-bg); }
`

/** The toolbar in the pill, after the pill's button styles. It takes the pill's font and colors. */
export const pillBarStyles = `
:host { font: inherit; color: inherit; color-scheme: inherit; }
/* The overlay's mount point sits between the segment and the toolbar. It passes the pill's alignment on, so items such as the avatars center like the buttons. */
:host > div { align-items: inherit; }
.toolbar { display: flex; flex-direction: var(--vitehub-pill-flow, row); align-items: inherit; gap: 2px; font-variant-numeric: tabular-nums; }
.toolbar svg { flex: none; }
.sep { width: 4px; height: 4px; flex: none; }
.actions { display: flex; flex-direction: inherit; align-items: inherit; gap: 2px; }
.divider { width: 1px; height: 16px; margin: 0 4px; flex: none; background: var(--vitehub-pill-line); }
.count { min-width: 16px; padding: 0 4px; border-radius: 4px; background: var(--vitehub-pill-hover); font-size: 10px; line-height: 17px; text-align: center; }
button[aria-pressed="true"] .count, button[aria-expanded="true"] .count { display: none; }
/* The tips and the colors stay rows of square buttons, also when the pill docks to a side and stacks the other controls. */
.swatches { display: flex; gap: 2px; }
.swatch, .icon { width: 28px; padding: 0; justify-content: center; }
.icon { align-self: flex-start; }
.swatch span { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 20%); }
.swatch[aria-pressed="true"] { background: var(--vitehub-pill-hover); box-shadow: inset 0 0 0 1.5px var(--vitehub-pill-strong); color: inherit; }
button.done:not(:disabled) { background: var(--vitehub-pill-on); color: var(--vitehub-pill-on-text); }
button:disabled { opacity: .45; cursor: default; }
.people { display: flex; padding: 0 2px; }
.avatar { width: 20px; height: 20px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 600; color: #18181b; overflow: hidden; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.avatar + .avatar { margin-left: -6px; box-shadow: 0 0 0 2px var(--vitehub-pill-surface); }
img.me { width: 18px; height: 18px; border-radius: 50%; object-fit: cover; }
`

/**
 * Rules in the host document: edit mode, scoped to classes on `<html>`, and the highlights of commented text, as in Drop.
 * Highlights draw on the page itself, so they take a grey that shows on light and dark pages.
 */
export const documentStyles = `
::highlight(vitehub-comment) { background-color: rgb(128 128 128 / 18%); }
::highlight(vitehub-comment-resolved) { background-color: rgb(128 128 128 / 8%); }
::highlight(vitehub-comment-active) { background-color: rgb(128 128 128 / 34%); }
html.vitehub-edit-mode [data-content-field] { cursor: text !important; }
[data-vitehub-editing] { outline: 2px solid #2563eb !important; outline-offset: 2px; border-radius: 2px; }
`

/**
 * The areas that threads point at, in their own element at z-index 1 of the page: over its text, under its own
 * floating controls, such as a menu button, which a box must not cross. An area is a thin, soft line with no fill, so a
 * page with many of them stays readable. The area of the open thread shows clearly. A resolved area is dashed and faint.
 */
export const areaStyles = `
:host { all: initial; position: fixed; inset: 0; z-index: 1; pointer-events: none; --ink: #171717; --muted: #737373; }
:host(.dark) { --ink: #fafafa; --muted: #a3a3a3; }
.area {
  position: fixed; box-sizing: border-box; border: 1px solid color-mix(in oklab, var(--ink) 22%, transparent); border-radius: 4px;
  transition: border-color 120ms ease-out, background-color 120ms ease-out;
}
.area[data-status="active"] { border-color: color-mix(in oklab, var(--ink) 55%, transparent); background: color-mix(in oklab, var(--ink) 4%, transparent); }
.area[data-status="resolved"] { border-style: dashed; border-color: color-mix(in oklab, var(--muted) 40%, transparent); }
@media (prefers-reduced-motion: reduce) { .area { transition: none; } }
`
