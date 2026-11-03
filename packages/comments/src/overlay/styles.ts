/**
 * Styles of the overlay's own pieces. The comment parts bring theirs from `@vite-hub/ui/styles.css`. All of them live
 * in shadow roots, so the host page's CSS does not reach them: the overlay, its toolbar in the page tools pill, and
 * the list in the pill's window. The overlay takes the page's font and follows its light or dark scheme. It sets the Nuxt UI
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
.root { position: fixed; inset: 0; pointer-events: none; z-index: 2147482999; font-family: var(--font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif); }
.root > * { pointer-events: auto; }
.root > .cursors, .root > .outlines { pointer-events: none; }
.avatar { width: 24px; height: 24px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #18181b; overflow: hidden; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }

.cursor { position: fixed; transform: translate(-2px, -2px); transition: left 80ms linear, top 80ms linear; }
.cursor svg { display: block; filter: drop-shadow(0 1px 1px rgb(0 0 0 / .25)); }
.cursor span { display: inline-block; margin: 2px 0 0 12px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; color: #18181b; white-space: nowrap; box-shadow: 0 1px 3px rgb(0 0 0 / .2); }

.outline { position: fixed; border: 2px solid var(--vh-ui-primary); border-radius: 4px; }
.outline[data-kind="draft"] { border-style: dashed; border-color: #f59e0b; }
.tag { position: fixed; transform: translateY(-100%); padding: 2px 6px; border-radius: 4px 4px 0 0; background: #f59e0b; color: #18181b; font-size: 11px; font-weight: 600; }
.outline[data-kind="hover"] + .tag { background: var(--vh-ui-primary); color: #fff; }

.card { position: fixed; left: 50%; bottom: 68px; translate: -50% 0; z-index: 2147483001; width: min(320px, calc(100vw - 32px)); display: grid; gap: 8px; padding: 12px; background: var(--vh-ui-bg); color: var(--vh-ui-text); border: 1px solid var(--vh-ui-border); border-radius: calc(var(--vh-ui-radius) * 1.5); box-shadow: 0 8px 24px rgb(0 0 0 / .16); font-size: 13px; }
.card label { display: grid; gap: 4px; font-weight: 500; }
.card input { font: inherit; color: inherit; background: var(--vh-ui-bg-elevated); border: 1px solid var(--vh-ui-border); border-radius: var(--vh-ui-radius); padding: 6px 8px; }
.card input:focus-visible { outline: 2px solid var(--vh-ui-ring); outline-offset: 0; }
@media (pointer: coarse) { .card input { font-size: 16px; } }
.card .row { display: flex; justify-content: flex-end; gap: 6px; }

.toast { position: fixed; left: 50%; bottom: 68px; translate: -50% 0; z-index: 2147483001; max-width: min(520px, calc(100vw - 32px)); padding: 8px 8px 8px 14px; background: var(--vh-ui-bg); color: var(--vh-ui-text); border: 1px solid var(--vh-ui-border); border-radius: 12px; box-shadow: 0 8px 24px -6px rgb(0 0 0 / .16); display: flex; gap: 12px; align-items: center; font-size: 13px; text-wrap: pretty; }
.toast[data-kind="error"] { border-color: color-mix(in oklab, var(--vh-ui-error) 45%, transparent); }
.toast a { color: var(--vh-ui-primary); font-weight: 500; white-space: nowrap; text-underline-offset: 3px; }
.toast > span { padding: 4px 0; }

@keyframes vitehub-comments-enter { from { opacity: 0; transform: translateY(4px); } }
.toast, .card { animation: vitehub-comments-enter 180ms cubic-bezier(.23, 1, .32, 1); }
@media (prefers-reduced-motion: reduce) {
  .toast, .card { animation: none; }
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
[data-slot="comment-panel"] { height: 100%; background: var(--vh-ui-bg); }
`

/** The toolbar in the pill, after the pill's button styles. It takes the pill's font and colors. */
export const pillBarStyles = `
:host { font: inherit; color: inherit; color-scheme: inherit; }
.toolbar { display: flex; flex-direction: var(--vitehub-pill-flow, row); align-items: inherit; gap: 2px; font-variant-numeric: tabular-nums; }
.toolbar svg { flex: none; }
.sep { width: 4px; height: 4px; flex: none; }
.people { display: flex; padding: 0 2px; }
.avatar { width: 20px; height: 20px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 600; color: #18181b; overflow: hidden; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.avatar + .avatar { margin-left: -6px; box-shadow: 0 0 0 2px var(--vitehub-pill-surface); }
img.me { width: 18px; height: 18px; border-radius: 50%; object-fit: cover; }
`

/** Rules in the host document, scoped to classes on `<html>`, for edit mode. */
export const documentStyles = `
html.vitehub-edit-mode [data-content-field] { cursor: text !important; }
[data-vitehub-editing] { outline: 2px solid #2563eb !important; outline-offset: 2px; border-radius: 2px; }
`
