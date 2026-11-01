/**
 * Styles of the overlay. They live in its shadow root, and in the shadow root of its toolbar (`.bar`) in the page tools
 * pill, so the host page's CSS does not reach them. The overlay takes the page's font and follows its light or dark
 * scheme (`data-theme` on `.root`), so it reads as part of the site. The toolbar is part of the dark pill instead.
 */
export const overlayStyles = `
:host { all: initial; }
* { box-sizing: border-box; }
.root, .bar {
  --surface: #fff; --surface-inset: #f4f4f5; --hover: rgb(0 0 0 / .05); --text: #18181b; --body: #3f3f46; --muted: #71717a;
  --ring: rgb(0 0 0 / .08); --divider: rgb(0 0 0 / .06); --accent: #2563eb; --on-accent: #fff; --accent-soft: rgb(37 99 235 / .1);
  --accent-text: #1d4ed8; --danger: #dc2626;
  --shadow: 0 0 0 1px var(--ring), 0 1px 2px rgb(0 0 0 / .04), 0 8px 24px -6px rgb(0 0 0 / .16);
  --ease-out: cubic-bezier(.23, 1, .32, 1);
  font: 13px/1.5 var(--font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif); color: var(--text);
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
}
.root { position: fixed; inset: 0; pointer-events: none; z-index: 2147482999; }
.root[data-theme="dark"], .bar[data-theme="dark"] {
  --surface: #1c1c1f; --surface-inset: #121214; --hover: rgb(255 255 255 / .06); --text: #fafafa; --body: #e4e4e7; --muted: #a1a1aa;
  --ring: rgb(255 255 255 / .1); --divider: rgb(255 255 255 / .07); --accent-soft: rgb(96 165 250 / .14); --accent-text: #93c5fd; --danger: #f87171;
  --shadow: 0 0 0 1px var(--ring), 0 1px 2px rgb(0 0 0 / .3), 0 12px 32px -8px rgb(0 0 0 / .6);
}
.root * { pointer-events: auto; }
.layer { position: fixed; inset: 0; pointer-events: none; }
.layer * { pointer-events: none; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; transition: background-color 120ms ease, color 120ms ease, transform 120ms ease; }
button:active:not(:disabled) { transform: scale(.96); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
textarea:focus-visible, input:focus-visible { outline: none; box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 3px var(--accent-soft); }
.icon svg { flex: none; }

.toolbar { display: flex; align-items: center; gap: 2px; }
.avatar { width: 24px; height: 24px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #18181b; overflow: hidden; }
.avatar img { width: 100%; height: 100%; object-fit: cover; outline: 1px solid rgb(0 0 0 / .1); outline-offset: -1px; border-radius: 50%; }

.pin { position: fixed; transform: translate(-50%, -50%); }
.layer .pin, .layer .pin * { pointer-events: auto; }
.pin-button { position: relative; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: #18181b; box-shadow: 0 0 0 2px #fff, 0 2px 8px rgb(0 0 0 / .25); transition: transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease; }
.pin-button::after { content: ""; position: absolute; inset: -6px; border-radius: 50%; }
@media (hover: hover) and (pointer: fine) { .pin-button:hover { transform: scale(1.08); } }
.pin[data-open="true"] .pin-button { box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--accent), 0 2px 8px rgb(0 0 0 / .25); }
.pin[data-state="resolved"] .pin-button { background: #e4e4e7 !important; color: #52525b; opacity: .85; }
.pin[data-state="draft"] .pin-button { box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--accent), 0 2px 8px rgb(0 0 0 / .25); }
.pin[data-state="moved"] .pin-button { box-shadow: 0 0 0 2px #fff, 0 2px 8px rgb(0 0 0 / .25); outline: 2px dashed #f59e0b; outline-offset: 3px; }

.card { position: fixed; width: 320px; max-height: min(480px, calc(100vh - 32px)); display: flex; flex-direction: column; background: var(--surface); border-radius: 14px; box-shadow: var(--shadow); overflow: hidden; transform-origin: top left; }
.card-head { display: flex; align-items: center; gap: 2px; padding: 8px 8px 0 14px; color: var(--muted); font-size: 12px; }
.card-head .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon { position: relative; width: 28px; height: 28px; flex: none; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
.icon:hover { background: var(--hover); color: var(--text); }
.icon.danger:hover { color: var(--danger); }
.messages { overflow: auto; padding: 4px 0 8px; overscroll-behavior: contain; }
.message { display: grid; grid-template-columns: 24px minmax(0, 1fr); column-gap: 10px; padding: 8px 14px; }
.message-head { display: flex; align-items: center; gap: 6px; min-height: 24px; }
.message-head .name { font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-head .time { color: var(--muted); font-size: 12px; flex: 1; white-space: nowrap; font-variant-numeric: tabular-nums; }
.message-head .icon { width: 24px; height: 24px; margin: -2px -4px -2px 0; opacity: 0; }
.message:hover .message-head .icon, .message:focus-within .message-head .icon { opacity: 1; }
.body { grid-column: 2; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--body); text-wrap: pretty; }
.mention { color: var(--accent-text); font-weight: 500; }
.compose { padding: 8px; display: flex; flex-direction: column; gap: 6px; position: relative; border-top: 1px solid var(--divider); }
.card[data-card="new"] .compose { border-top: 0; }
textarea, input { width: 100%; font: inherit; color: var(--text); background: var(--surface-inset); border: 0; border-radius: 6px; padding: 8px 10px; resize: none; box-shadow: inset 0 0 0 1px var(--ring); }
textarea::placeholder, input::placeholder { color: var(--muted); }
textarea { min-height: 38px; max-height: 160px; field-sizing: content; }
@media (pointer: coarse) { textarea, input { font-size: 16px; } }
.row { display: flex; justify-content: flex-end; gap: 6px; align-items: center; padding-left: 2px; }
.row .hint { flex: 1; color: var(--muted); font-size: 12px; }
.primary { height: 28px; padding: 0 12px; border-radius: 6px; background: var(--accent); color: var(--on-accent); font-weight: 500; }
.primary:hover:not(:disabled) { background: #1d4ed8; }
.primary:disabled { background: var(--surface-inset); color: var(--muted); box-shadow: inset 0 0 0 1px var(--ring); cursor: default; }
.secondary { height: 28px; padding: 0 10px; border-radius: 6px; color: var(--body); font-weight: 500; }
.secondary:hover { background: var(--hover); color: var(--text); }
.suggest { position: absolute; left: 8px; right: 8px; bottom: calc(100% - 4px); background: var(--surface); border-radius: 10px; padding: 4px; box-shadow: var(--shadow); }
.suggest button { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 4px 8px 4px 4px; border-radius: 6px; }
.suggest .avatar { width: 20px; height: 20px; font-size: 9px; }
.suggest button[aria-selected="true"], .suggest button:hover { background: var(--hover); }

.panel { position: fixed; top: 16px; right: 16px; bottom: 72px; width: 340px; display: flex; flex-direction: column; background: var(--surface); border-radius: 14px; box-shadow: var(--shadow); overflow: hidden; transform-origin: right center; }
.panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 8px 10px 16px; border-bottom: 1px solid var(--divider); }
.panel-head .title { flex: 1; min-width: 0; }
.panel-head h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--text); }
.panel-head .page { color: var(--muted); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.switch { display: inline-flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px; border-radius: 6px; color: var(--body); font-size: 12px; font-weight: 500; }
.switch:hover { background: var(--hover); }
.switch .track { width: 26px; height: 16px; border-radius: 999px; background: var(--ring); position: relative; transition: background-color 120ms ease; }
.switch .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / .3); transition: transform 160ms var(--ease-out); }
.switch[aria-checked="true"] .track { background: var(--accent); }
.switch[aria-checked="true"] .track::after { transform: translateX(10px); }
.panel-list { overflow: auto; flex: 1; padding: 6px; overscroll-behavior: contain; }
.panel-item { display: grid; grid-template-columns: 24px minmax(0, 1fr); column-gap: 10px; width: 100%; text-align: left; padding: 10px; border-radius: 8px; }
.panel-item:hover { background: var(--hover); }
.panel-item[aria-current="true"] { background: var(--accent-soft); }
.panel-item .top { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.panel-item .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel-item .time { color: var(--muted); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.panel-item .excerpt { grid-column: 2; color: var(--body); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
.panel-item .meta { grid-column: 2; margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.panel-item[data-state="resolved"] .avatar, .panel-item[data-state="resolved"] .excerpt { opacity: .6; }
.empty { display: grid; justify-items: center; gap: 4px; padding: 40px 24px; color: var(--muted); text-align: center; text-wrap: balance; }
.empty strong { color: var(--text); font-weight: 600; }

.cursor { position: fixed; transform: translate(-2px, -2px); transition: left 80ms linear, top 80ms linear; }
.cursor svg { display: block; filter: drop-shadow(0 1px 1px rgb(0 0 0 / .25)); }
.cursor span { display: inline-block; margin: 2px 0 0 12px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; color: #18181b; white-space: nowrap; box-shadow: 0 1px 3px rgb(0 0 0 / .2); }

.outline { position: fixed; border: 2px solid var(--accent); border-radius: 4px; }
.outline[data-kind="draft"] { border-style: dashed; border-color: #f59e0b; }
.tag { position: fixed; transform: translateY(-100%); padding: 2px 6px; border-radius: 4px 4px 0 0; background: #f59e0b; color: #18181b; font-size: 11px; font-weight: 600; }
.outline[data-kind="hover"] + .tag { background: var(--accent); color: var(--on-accent); }

.toast { position: fixed; left: 50%; bottom: 68px; translate: -50% 0; max-width: min(520px, calc(100vw - 32px)); padding: 8px 8px 8px 14px; background: var(--surface); color: var(--body); border-radius: 12px; box-shadow: var(--shadow); display: flex; gap: 12px; align-items: center; text-wrap: pretty; }
.toast[data-kind="error"] { box-shadow: 0 0 0 1px rgb(220 38 38 / .35), 0 8px 24px -6px rgb(0 0 0 / .16); }
.toast a { color: var(--accent-text); font-weight: 500; white-space: nowrap; text-underline-offset: 3px; }
.toast > span { padding: 4px 0; }

@keyframes enter { from { opacity: 0; transform: translateY(4px) scale(.97); } }
@keyframes enter-panel { from { opacity: 0; transform: translateX(8px); } }
@keyframes fade { from { opacity: 0; } }
.card:not([data-static]), .toast:not([data-static]) { animation: enter 180ms var(--ease-out); }
.panel:not([data-static]) { animation: enter-panel 200ms var(--ease-out); }
@media (prefers-reduced-motion: reduce) {
  .card:not([data-static]), .toast:not([data-static]), .panel:not([data-static]) { animation: fade 120ms ease-out; }
  button, .pin-button, .switch .track::after { transition: none; }
  button:active:not(:disabled) { transform: none; }
  .cursor { transition: none; }
}
`

/** The toolbar in the pill, after `overlayStyles` and the pill's button styles. It takes the pill's font and colors. */
export const pillBarStyles = `
:host { font: inherit; color: inherit; color-scheme: inherit; }
.bar { font: inherit; color: inherit; --surface: var(--vitehub-pill-surface); --muted: var(--vitehub-pill-muted); --divider: var(--vitehub-pill-line); }
.toolbar { gap: 4px; }
.bar button { transform: none; font-variant-numeric: tabular-nums; }
.sep { width: 1px; height: 18px; background: var(--divider); margin: 0 2px; }
.people { display: flex; padding: 0 2px; }
.people .avatar { width: 20px; height: 20px; font-size: 9px; }
.people .avatar + .avatar { margin-left: -6px; box-shadow: 0 0 0 2px var(--surface); }
img.me { width: 18px; height: 18px; border-radius: 50%; object-fit: cover; }
`

/** One rule in the host document, scoped to a class on `<html>`, so the crosshair shows over every element in comment mode. */
export const documentStyles = `
html.vitehub-comment-mode, html.vitehub-comment-mode * { cursor: crosshair !important; }
html.vitehub-edit-mode [data-content-field] { cursor: text !important; }
[data-vitehub-editing] { outline: 2px solid #2563eb !important; outline-offset: 2px; border-radius: 2px; }
`
