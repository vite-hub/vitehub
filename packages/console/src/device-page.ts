import { deviceScript } from "./device-page.injected.ts"
import { renderStandalonePage } from "./oauth-page.ts"

/**
 * The `/device` page of `vitehub login`. The CLI prints a code and this address. Signed out, the person signs in with
 * GitHub or a passkey and comes back. Signed in, they type the code (or open the link with it), see which machine asked,
 * pick a team, and approve or deny. Approval gives the CLI an API key for that team; the page never sees the key.
 */
const styles = `
form { display: flex; gap: 8px; }
input, select { flex: 1; min-width: 0; height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; font-size: 16px; }
#code { font-family: ui-monospace, monospace; letter-spacing: 0.08em; text-transform: uppercase; }
input:focus-visible, select:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
.panel { flex-direction: column; align-items: stretch; }
.row { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
.row > span:first-child { color: var(--muted); }
#code-shown { font-family: ui-monospace, monospace; letter-spacing: 0.08em; }
label { display: grid; gap: 6px; font-size: 14px; color: var(--muted); }
`

export function renderDevicePage(): Response {
  return renderStandalonePage({
    title: "Connect the ViteHub CLI",
    script: deviceScript,
    styles,
    body: `      <h1>Connect the ViteHub CLI</h1>
      <p id="text">One moment.</p>
      <form id="code-form" hidden>
        <input id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-1234" aria-label="Code" required>
        <button type="submit">Continue</button>
      </form>
      <div id="request" class="panel" hidden>
        <div class="row"><span>Asked by</span><span id="client"></span></div>
        <div class="row"><span>Code</span><span id="code-shown"></span></div>
        <label>Team<select id="team"></select></label>
        <p class="note">The CLI gets an API key for this team that acts as you for 90 days.</p>
      </div>
      <div id="buttons" class="actions"></div>
      <p id="sign-in" class="note" hidden>New to ViteHub? <a href="/" target="_blank" rel="noopener">Create an account</a>, then sign in here.</p>
      <p role="alert" hidden></p>`,
  })
}
