const deliveryStyles = `
[data-slot="comment-reply-status"] { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--ui-text-muted); }
.delivery[data-failed] { color: var(--vh-error); }
`

const themeTokens = `
:host {
  all: initial;
  --ui-bg: #fff; --ui-bg-elevated: #f5f5f5; --ui-bg-accented: #e5e5e5; --ui-bg-muted: #fafafa; --ui-border: #e5e5e5;
  --ui-text: #404040; --ui-text-muted: #737373; --ui-text-highlighted: #171717; --ui-text-inverted: #fff; --ui-primary: #171717;
}
:host(.dark) {
  --ui-bg: #171717; --ui-bg-elevated: #262626; --ui-bg-accented: #404040; --ui-bg-muted: #1f1f1f; --ui-border: rgb(255 255 255 / 12%);
  --ui-text: #e5e5e5; --ui-text-muted: #a3a3a3; --ui-text-highlighted: #fafafa; --ui-text-inverted: #171717; --ui-primary: #fafafa;
}
`

export const overlayStyles = `
${themeTokens}
.root { position: fixed; inset: 0; pointer-events: none; z-index: 2147482999; font-family: "Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.root > * { pointer-events: auto; }
/* The comment layer covers the page. Only its parts and the comment mode overlay take the pointer, as @vite-hub/ui styles them. */
.root > .cursors, .root > .outlines, .root > .areas, .root > [data-slot="comment-layer"] { pointer-events: none; }
.avatar { width: 24px; height: 24px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #18181b; overflow: hidden; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }

/* Each cursor moves to its next place with the list mover of the motion layer. */
.cursor { position: fixed; transform: translate(-2px, -2px); }
.cursor svg { display: block; filter: drop-shadow(0 1px 1px rgb(0 0 0 / .25)); }
.cursor span { display: inline-block; margin: 2px 0 0 12px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; color: #18181b; white-space: nowrap; box-shadow: 0 1px 3px rgb(0 0 0 / .2); }

.outline { position: fixed; border: 2px solid var(--vh-comment-mark); border-radius: 4px; }
.outline[data-kind="draft"] { border-style: dashed; border-color: #f59e0b; }
.tag { position: fixed; transform: translateY(-100%); padding: 2px 6px; border-radius: 4px 4px 0 0; background: #f59e0b; color: #18181b; font-size: 11px; font-weight: 600; }
.outline[data-kind="hover"] + .tag { background: var(--vh-comment-mark); color: #fff; }

.card { position: fixed; left: 50%; bottom: 68px; translate: -50% 0; z-index: 2147483001; width: min(320px, calc(100vw - 32px)); display: grid; gap: 8px; padding: 12px; background: var(--vh-bg); color: var(--vh-text); border: 1px solid var(--vh-border); border-radius: calc(var(--vh-radius) * 1.5); box-shadow: 0 8px 24px rgb(0 0 0 / .16); font-size: 13px; }
.card label { display: grid; gap: 4px; font-weight: 500; }
.card input { font: inherit; color: inherit; background: var(--vh-bg-elevated); border: 1px solid var(--vh-border); border-radius: var(--vh-radius); padding: 6px 8px; }
.card input:focus-visible { outline: 2px solid var(--vh-ring); outline-offset: 0; }
@media (pointer: coarse) { .card input { font-size: 16px; } }
.card .row { display: flex; justify-content: flex-end; gap: 6px; }

/* The toast is the item of a notifications region, so the toast effect of the motion layer brings it in from the bottom edge. */
.toasts { position: fixed; left: 50%; bottom: 68px; translate: -50% 0; z-index: 2147483001; display: grid; justify-items: center; margin: 0; padding: 0; list-style: none; }
.toast { max-width: min(520px, calc(100vw - 32px)); padding: 8px 8px 8px 14px; background: var(--vh-bg); color: var(--vh-text); border: 1px solid var(--vh-border); border-radius: 12px; box-shadow: 0 8px 24px -6px rgb(0 0 0 / .16); display: flex; gap: 12px; align-items: center; font-size: 13px; text-wrap: pretty; }
.toast[data-kind="error"] { border-color: color-mix(in oklab, var(--vh-error) 45%, transparent); }
.toast a { color: var(--vh-primary); font-weight: 500; white-space: nowrap; text-underline-offset: 3px; }
.toast > span { padding: 4px 0; }

/*
 * Where the pins go. Their look is Drop's, in @vite-hub/ui/comment-marks.css. A pin sits in the gutter right of a
 * quote's block, level with its last line; at the corner of an area; at the point of a click. --pin-x and --pin-y place
 * the pin's corner from the spot, and the card opens beside the pin, level with it, or under it near the right edge of
 * the screen.
 */
[data-slot="comment-layer-item"] { --pin-x: 0px; --pin-y: calc(var(--vh-comment-pin-size) * -1); }
[data-slot="comment-layer-item"][data-kind="text"] { --pin-x: 0px; --pin-y: calc(var(--vh-comment-pin-size) / -2); }
[data-slot="comment-layer-item"]:is([data-kind="area"], [data-kind="image"]) { --pin-x: calc(var(--vh-comment-pin-size) / -2); --pin-y: calc(var(--vh-comment-pin-size) / -2); }
/* The pin's own transform is its zoom and its active size, from comment-marks.css. */
[data-slot="comment-pin"] { touch-action: manipulation; translate: var(--pin-x) var(--pin-y); }
[data-kind="text"] > [data-slot="comment-pin"] { transform-origin: 0 50%; }
[data-slot="comment-pin"] [data-slot="avatar-stack"] { --vh-avatar-size: var(--vh-comment-pin-size); display: block; }
[data-slot="comment-pin"] [data-slot="avatar-stack-item"] {
  border-radius: inherit; box-shadow: none; background: none; color: inherit; font: 600 11px/var(--vh-comment-pin-size) "Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: .02em;
}
[data-slot="comment-pin-number"] { display: none; }
[data-slot="comment-pin"][data-draft="true"] { outline: none; }

/*
 * --popover-width is the width the card wants. On a narrow screen it is the screen less 12px each side, and the card
 * moves toward the middle so that no part of it goes off screen. --vh-comment-x is the x of the spot on the screen.
 * A dark page hides the shadow, and a Nuxt UI page's \`.dark\` tokens also reach the host, so a card can have the page's
 * color. The hairline keeps its edge in view: a new comment's bubble edge, else the border color.
 */
[data-slot="comment-layer-popover"] {
  --popover-width: 340px; --popover-room: min(var(--popover-width), calc(100vw - 24px));
  --popover-side-left: calc(var(--pin-x) + 36px);
  --popover-left: min(var(--popover-side-left), calc(100vw - 12px - var(--popover-room) - var(--vh-comment-x, 0px)));
  left: var(--popover-left);
  top: var(--pin-y); width: var(--popover-room); max-width: none;
  border-radius: 6px 16px 16px 16px; box-shadow: 0 0 0 1px var(--vh-bubble-edge, var(--vh-border)), 0 8px 24px rgb(0 0 0 / .16), 0 1px 3px rgb(0 0 0 / .08);
}
[data-draft="true"] > [data-slot="comment-layer-popover"] { --popover-width: 300px; border-radius: 6px 18px 18px 18px; }
[data-draft="true"][data-kind="page"] > [data-slot="comment-layer-popover"] { --popover-left: var(--vh-comment-draft-left); }
[data-draft="true"]:not([data-flip-x="true"], [data-above="true"]) > [data-slot="comment-layer-popover"] {
  --popover-side-left: calc(var(--pin-x) + var(--vh-comment-pin-size) + 8px);
  --draft-clearance: calc(max(0, sign(var(--popover-side-left) - var(--popover-left))) * (var(--vh-comment-pin-size) + 8px));
  top: calc(var(--pin-y) + var(--draft-clearance));
}
[data-slot="comment-layer-popover"][data-preview="true"] { --popover-width: 18rem; }
[data-slot="comment-layer-item"][data-flip-x="true"] > [data-slot="comment-layer-popover"] {
  left: auto; right: clamp(calc(var(--vh-comment-x, 0px) + 12px - 100vw), calc(-28px - var(--pin-x)), calc(var(--vh-comment-x, 100vw) - var(--popover-room) - 12px)); top: calc(var(--pin-y) + 36px); border-radius: 16px 6px 16px 16px;
}
[data-slot="comment-layer-item"][data-flip-y="true"] > [data-slot="comment-layer-popover"] {
  top: auto; bottom: calc(-28px - var(--pin-y)); border-radius: 16px 16px 16px 6px;
}
[data-slot="comment-layer-item"][data-flip-x="true"][data-flip-y="true"] > [data-slot="comment-layer-popover"] {
  bottom: calc(8px - var(--pin-y)); border-radius: 16px 16px 6px 16px;
}
[data-draft="true"][data-flip-y="true"]:not([data-flip-x="true"], [data-above="true"]) > [data-slot="comment-layer-popover"] {
  bottom: calc(var(--draft-clearance) - var(--vh-comment-pin-size) - var(--pin-y));
}
[data-slot="comment-layer-item"][data-above="true"] > [data-slot="comment-layer-popover"] {
  top: auto; bottom: calc(var(--pin-y) * -1 + 4px); border-radius: 16px 16px 16px 6px;
}
[data-slot="comment-layer-popover"][data-floating="true"] { border-radius: 16px; }
/* The whole-page island has the cards' surface and shadow. */
[data-slot="comment-page-island-card"] { box-shadow: 0 0 0 1px var(--vh-border), 0 8px 24px rgb(0 0 0 / .16), 0 1px 3px rgb(0 0 0 / .08); }
/* The overlay places a card beside its pin itself, so it turns off the CSS anchor placement of @vite-hub/ui/styles.css. */
[data-slot="comment-layer-item"]:not([data-draft]) > [data-slot="comment-layer-popover"]:not([data-margin], [data-floating]) {
  position: absolute; margin: 0; position-area: none; position-try-fallbacks: none;
}

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

/* The area that a drag in comment mode draws, as comment-marks.css draws it. The overlay is fixed to the screen. The
   areas of threads are in their own root, under the page's floating controls (see areaStyles). */
[data-slot="comment-layer-area"] { position: fixed; }

/* The bar over selected text is CommentSelectionBar of @vite-hub/ui. The overlay places it over the text, or under it
   near the top of the screen. The page's theme does not reach the shadow root, so the overlay draws the focus ring. */
.selection { position: fixed; z-index: 2147483001; translate: -50% -100%; }
.selection[data-below="true"] { translate: -50% 0; }
[data-slot="comment-selection-bar-action"]:focus-visible { outline: 2px solid var(--vh-inverted); outline-offset: 1px; }
${deliveryStyles}
`

/**
 * The list in the pill's window. It follows the page's theme, as the comment cards do: the overlay sets `.dark` on its
 * host, which picks the Nuxt UI tokens that the parts read. The list has no background, so it shows the window's surface.
 */
export const panelStyles = `
${themeTokens}
:host { display: block; height: 100%; color-scheme: light; }
:host(.dark) { color-scheme: dark; }
.panel-root { height: 100%; }
[data-slot="comment-panel"] { height: 100%; background: none; border: 0; container-type: inline-size; }
/* One row under the window's title: the filters on the left, the page's actions on the right. It never wraps. */
[data-slot="comment-panel-header"] { flex-wrap: nowrap; gap: 8px; padding: 6px 8px; }
/* In a window too narrow for the row, the filters scroll sideways and the actions keep their size. */
[data-slot="comment-panel-filters"] { flex: 1 1 auto; flex-wrap: nowrap; min-width: 0; overflow-x: auto; scrollbar-width: none; padding: 2px; margin: -2px; }
[data-slot="comment-panel-filters"] > * { flex: none; }
[data-slot="comment-panel-actions"] { flex: none; flex-wrap: nowrap; }
[data-slot="comment-panel-header"] button, [data-slot="comment-panel-header"] a { white-space: nowrap; }
@container (max-width: 479px) {
  [data-slot="comment-panel-actions"] [data-action="open-in-t3-code"] > span { display: none; }
}
@container (max-width: 299px) {
  [data-slot="comment-panel-actions"] [data-action="copy-page-prompt"] > span:not([data-slot]) { display: none; }
}
${deliveryStyles}
`

/** The toolbar in the pill, after the pill's button styles. It takes the pill's font and colors. */
export const pillBarStyles = `
:host { font: inherit; color: inherit; color-scheme: inherit; }
/* The tones of a status in the dark pill, such as Send's Not delivered, Limit reached, and the Working dot. */
:host { --vitehub-pill-error: oklch(0.704 0.191 22.216); --vitehub-pill-warning: #fbbf24; --vitehub-pill-success: #34d399; }
/* The overlay's mount point sits between the segment and the toolbar. It passes the pill's alignment on, so items such as the avatars center like the buttons. */
:host > div { align-items: inherit; }
.toolbar { display: flex; flex-direction: var(--vitehub-pill-flow, row); align-items: inherit; gap: 2px; font-variant-numeric: tabular-nums; }
.toolbar svg { flex: none; }
.sep { width: 4px; height: 4px; flex: none; }
/* Comments and its eye stay one row, also when the pill docks to a side and stacks the other controls. */
.lead { display: flex; align-items: center; align-self: stretch; gap: 2px; }
.lead > :first-child { flex: 1 1 auto; }
.more { display: flex; flex-direction: inherit; align-items: inherit; gap: 2px; }
.more[hidden] { display: none; }
/* While Send pairs an agent, its message stands between dividers: 1px along the bar, across it on a side. */
[data-slot="comment-send"]:is([data-state="pairing"], [data-state="confirm"])::before,
[data-slot="comment-send"]:is([data-state="pairing"], [data-state="confirm"])::after { content: ""; flex: 0 0 1px; align-self: stretch; margin: 6px; background: var(--vitehub-pill-line); }
.count { min-width: 16px; padding: 0 4px; border-radius: 4px; background: var(--vitehub-pill-hover); font-size: 10px; line-height: 17px; text-align: center; }
button[aria-pressed="true"] .count, button[aria-expanded="true"] .count { display: none; }
/* The tips and the colors stay rows of square buttons, also when the pill docks to a side and stacks the other controls. */
.swatches { display: flex; gap: 2px; }
.swatch, .icon, .eye, .toggle { width: 28px; padding: 0; justify-content: center; }
.eye[data-comments-hidden="true"] { background: var(--vitehub-pill-on); color: var(--vitehub-pill-on-text); }
.toggle[aria-expanded="true"] .plus { rotate: 45deg; }
/* Open, the toggle keeps a plain fill, so its × does not look like a second pill close button. */
.toggle[aria-expanded="true"]:not(:hover) { background: none; color: inherit; }
/* Both labels share one cell, so the button and the pill keep their width when Copy prompt turns to Copied. */
.swap { display: inline-grid; justify-items: start; }
.swap > span { grid-area: 1 / 1; display: inline-flex; align-items: center; gap: 4px; }
.swap > [data-shown="false"] { visibility: hidden; }
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
 * Rules in the host document: edit mode, scoped to classes on `<html>`. The overlay puts them after
 * `@vite-hub/ui/comment-marks.css`, which colors the highlights of commented text.
 */
export const documentStyles = `
html.vitehub-edit-mode [data-content-field] { cursor: text !important; }
[data-vitehub-editing] { outline: 2px solid #2563eb !important; outline-offset: 2px; border-radius: 2px; }
`

/**
 * The root of the areas that threads point at: an element at z-index 1 of the page, over its text and under its own
 * floating controls, such as a menu button, which a box must not cross. It covers the screen, so an area's `left` and
 * `top` are client coordinates. The areas themselves are `comment-mark-area`, as `@vite-hub/ui/comment-marks.css`
 * draws them for the pill and for Drop.
 */
export const areaStyles = `
:host { all: initial; position: fixed; inset: 0; z-index: 1; pointer-events: none; }
`
