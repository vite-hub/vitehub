/** Styles of the overlay. They live in its shadow root, so the host page's CSS does not reach them. */
export const overlayStyles = `
:host { all: initial; }
* { box-sizing: border-box; }
.root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #f4f4f5; }
.root * { pointer-events: auto; }
.layer { position: fixed; inset: 0; pointer-events: none; }
.layer * { pointer-events: none; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
button:focus-visible, textarea:focus-visible, input:focus-visible { outline: 2px solid #60a5fa; outline-offset: 1px; }

.toolbar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; align-items: center; gap: 2px; padding: 4px; background: #000; border: 1px solid #27272a; border-radius: 10px; }
.tool { height: 30px; min-width: 30px; padding: 0 10px; border-radius: 7px; display: inline-flex; align-items: center; gap: 6px; color: #a1a1aa; white-space: nowrap; }
.tool:hover { background: #18181b; color: #fff; }
.tool[aria-pressed="true"] { background: #fff; color: #000; }
.tool kbd { font: 11px ui-monospace, monospace; opacity: .6; }
.sep { width: 1px; height: 18px; background: #27272a; margin: 0 4px; }
.people { display: flex; padding: 0 4px; }
.avatar { width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #000; border: 2px solid #000; margin-left: -6px; overflow: hidden; }
.avatar:first-child { margin-left: 0; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }

.pin { position: fixed; transform: translate(-2px, -100%); }
.layer .pin, .layer .pin * { pointer-events: auto; }
.pin-button { width: 26px; height: 26px; border-radius: 13px 13px 13px 2px; background: #fff; color: #000; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; border: 2px solid #000; }
.pin[data-state="resolved"] .pin-button { background: #3f3f46; color: #d4d4d8; }
.pin[data-state="moved"] .pin-button { border-style: dashed; border-color: #fff; background: #000; color: #fff; }
.pin[data-open="true"] .pin-button { background: #60a5fa; }

.card { position: fixed; width: 300px; max-height: min(460px, calc(100vh - 32px)); display: flex; flex-direction: column; background: #000; border: 1px solid #27272a; border-radius: 10px; overflow: hidden; }
.card-head { display: flex; align-items: center; gap: 4px; padding: 6px 6px 6px 12px; border-bottom: 1px solid #18181b; color: #a1a1aa; font-size: 12px; }
.card-head .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon { width: 26px; height: 26px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; color: #a1a1aa; }
.icon:hover { background: #18181b; color: #fff; }
.messages { overflow: auto; padding: 4px 0; }
.message { padding: 8px 12px; }
.message-head { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
.message-head .name { font-weight: 600; color: #fff; }
.message-head .time { color: #71717a; font-size: 11px; flex: 1; }
.message-head .icon { width: 20px; height: 20px; opacity: 0; }
.message:hover .message-head .icon { opacity: 1; }
.body { white-space: pre-wrap; word-break: break-word; color: #e4e4e7; }
.mention { color: #93c5fd; }
.compose { border-top: 1px solid #18181b; padding: 8px; display: flex; flex-direction: column; gap: 6px; position: relative; }
textarea, input { width: 100%; font: inherit; color: #fff; background: #09090b; border: 1px solid #27272a; border-radius: 7px; padding: 7px 9px; resize: none; }
textarea { min-height: 56px; }
.row { display: flex; justify-content: flex-end; gap: 6px; align-items: center; }
.row .hint { flex: 1; color: #71717a; font-size: 11px; }
.primary { height: 28px; padding: 0 12px; border-radius: 7px; background: #fff; color: #000; font-weight: 600; }
.primary:disabled { opacity: .4; cursor: default; }
.secondary { height: 28px; padding: 0 10px; border-radius: 7px; color: #a1a1aa; }
.secondary:hover { background: #18181b; color: #fff; }
.suggest { position: absolute; left: 8px; right: 8px; bottom: 100%; background: #09090b; border: 1px solid #27272a; border-radius: 8px; padding: 4px; }
.suggest button { display: block; width: 100%; text-align: left; padding: 5px 8px; border-radius: 5px; }
.suggest button[aria-selected="true"], .suggest button:hover { background: #18181b; }

.panel { position: fixed; top: 16px; right: 16px; bottom: 72px; width: 320px; display: flex; flex-direction: column; background: #000; border: 1px solid #27272a; border-radius: 10px; overflow: hidden; }
.panel-list { overflow: auto; flex: 1; }
.panel-item { display: block; width: 100%; text-align: left; padding: 10px 12px; border-bottom: 1px solid #18181b; }
.panel-item:hover { background: #09090b; }
.panel-item .meta { color: #71717a; font-size: 11px; }
.panel-item .excerpt { color: #e4e4e7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { padding: 24px 12px; color: #71717a; text-align: center; }

.cursor { position: fixed; transform: translate(-2px, -2px); transition: left 80ms linear, top 80ms linear; }
.cursor svg { display: block; }
.cursor span { display: inline-block; margin: 2px 0 0 12px; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; color: #000; white-space: nowrap; }

.outline { position: fixed; border: 2px solid #60a5fa; border-radius: 3px; }
.outline[data-kind="draft"] { border-style: dashed; border-color: #fbbf24; }
.tag { position: fixed; transform: translateY(-100%); padding: 1px 6px; border-radius: 4px 4px 0 0; background: #fbbf24; color: #000; font-size: 10px; font-weight: 700; }
.outline[data-kind="hover"] + .tag { background: #60a5fa; }

.toast { position: fixed; left: 50%; bottom: 64px; transform: translateX(-50%); max-width: min(520px, calc(100vw - 32px)); padding: 8px 12px; background: #000; border: 1px solid #27272a; border-radius: 8px; display: flex; gap: 10px; align-items: center; }
.toast a { color: #93c5fd; }
.toast[data-kind="error"] { border-color: #7f1d1d; }
`

/** One rule in the host document, scoped to a class on `<html>`, so the crosshair shows over every element in comment mode. */
export const documentStyles = `
html.vitehub-comment-mode, html.vitehub-comment-mode * { cursor: crosshair !important; }
html.vitehub-edit-mode [data-content-field] { cursor: text !important; }
[data-vitehub-editing] { outline: 2px solid #60a5fa !important; outline-offset: 2px; }
`
