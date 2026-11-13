/**
 * The page where the sign-in of an MCP client lands. Better Auth's OAuth provider sends both its login step and its
 * consent step to `/oauth` with a signed query. Signed out, the person signs in with GitHub or a passkey, and the
 * provider resumes the authorization. Signed in, the person sees the account, where the answer goes, and allows or
 * denies the client.
 */

const authBase = "/api/auth"

// The page runs in the browser. It sends only the parameters that the provider signed back to the provider.
const script = `
const params = new URLSearchParams(location.search);
const $ = selector => document.querySelector(selector);
const heading = $("h1");
const text = $("#text");
const buttons = $("#buttons");
const alertBox = $("[role=alert]");
const names = new Set(params.getAll("ba_param"));
const signed = new URLSearchParams();
for (const [key, value] of params) if (key === "sig" || key === "ba_param" || names.has(key)) signed.append(key, value);
const oauthQuery = signed.toString();

function fromBase64url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}
function toBase64url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
}
async function run(action) {
  const controls = document.querySelectorAll("button");
  for (const control of controls) control.disabled = true;
  alertBox.hidden = true;
  try { await action(); } catch (error) {
    // A person who closed the passkey sheet chose not to sign in.
    if (!(error instanceof DOMException && error.name === "NotAllowedError")) {
      alertBox.textContent = error instanceof Error ? error.message : "Something went wrong. Start again from your agent.";
      alertBox.hidden = false;
    }
    for (const control of controls) control.disabled = false;
  }
}
function button(label, onClick, secondary) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (secondary) element.className = "secondary";
  element.addEventListener("click", () => run(onClick));
  buttons.append(element);
}
function leave(data, message) {
  const target = data && (data.url || data.redirect_uri);
  // Internal invariant: run() catches this error and shows its message in the alert.
  if (!target) throw new Error(message);
  location.assign(target);
}
async function post(path, body) {
  const response = await fetch(${JSON.stringify(authBase)} + path, {
    body: JSON.stringify({ ...body, oauth_query: oauthQuery }),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const data = await response.json().catch(() => ({}));
  // Internal invariant: run() catches this error and shows its message in the alert.
  if (!response.ok) throw new Error(data.error_description || data.message || "This link has expired. Start again from your agent.");
  return data;
}
const read = path => fetch(path, { credentials: "same-origin" }).then(response => response.ok ? response.json() : null).catch(() => null);

async function signInWithPasskey() {
  const options = await read(${JSON.stringify(`${authBase}/passkey/generate-authenticate-options`)});
  // Internal invariant: run() catches this error and shows its message in the alert.
  if (!options || !options.challenge) throw new Error("The passkey sign-in did not start. Try again.");
  const credential = await navigator.credentials.get({ publicKey: {
    ...options,
    challenge: fromBase64url(options.challenge),
    allowCredentials: (options.allowCredentials || []).map(entry => ({ ...entry, id: fromBase64url(entry.id) })),
  } });
  const answer = credential.response;
  const response = {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    response: {
      authenticatorData: toBase64url(answer.authenticatorData),
      clientDataJSON: toBase64url(answer.clientDataJSON),
      signature: toBase64url(answer.signature),
      userHandle: answer.userHandle ? toBase64url(answer.userHandle) : undefined,
    },
  };
  leave(await post("/passkey/verify-authentication", { response }), "The passkey sign-in did not finish. Try again.");
}

async function main() {
  if (!oauthQuery.includes("sig=")) {
    heading.textContent = "This link has expired";
    text.textContent = "Start the connection again from your agent. It opens a fresh link.";
    return;
  }
  const clientId = params.get("client_id") || "";
  const [session, client, methods] = await Promise.all([
    read(${JSON.stringify(`${authBase}/get-session`)}),
    // The signed query lets the page read the client's name before sign-in.
    post("/oauth2/public-client-prelogin", { client_id: clientId }).catch(() => null),
    read("/api/sign-in-methods"),
  ]);
  const name = client && client.client_name ? client.client_name : "an agent";
  if (!session || !session.user) {
    heading.textContent = "Sign in to connect " + name;
    text.textContent = "Then choose whether it may use your ViteHub Console account.";
    if (methods && methods.github) button("Continue with GitHub", async () => leave(await post("/sign-in/social", { callbackURL: "/", provider: "github" }), "Sign-in did not start. Try again."));
    if (typeof window.PublicKeyCredential === "function") button("Sign in with a passkey", signInWithPasskey, Boolean(methods && methods.github));
    $("#new").hidden = false;
    return;
  }
  heading.textContent = "Allow " + name + " to use your ViteHub Console account?";
  text.textContent = "It acts as you: it reads the docs, lists the apps of the team you opened last, and runs their operations with your role.";
  $("#name").textContent = session.user.name || "You";
  if (session.user.email && !session.user.email.endsWith("@passkey.invalid")) $("#email").textContent = session.user.email;
  $("#switch").addEventListener("click", () => run(async () => {
    const response = await fetch(${JSON.stringify(`${authBase}/sign-out`)}, { body: "{}", credentials: "same-origin", headers: { "content-type": "application/json" }, method: "POST" });
    // Internal invariant: run() catches this error and shows its message in the alert.
    if (!response.ok) throw new Error("Sign-out did not finish. Try again.");
    location.reload();
  }));
  $("#account").hidden = false;
  // The answer goes to the client's redirect address. Its host shows, so a lookalike name does not hide where it goes.
  try {
    const target = new URL(params.get("redirect_uri") || "");
    const code = document.createElement("code");
    code.textContent = target.protocol === "http:" || target.protocol === "https:" ? target.host : target.protocol.replace(/:$/, "");
    $("#redirect").append("Your answer goes to ", code, ". Anyone can register an agent under any name, so allow it only if you started this connection.");
  } catch {
    $("#redirect").textContent = "Anyone can register an agent under any name, so allow it only if you started this connection.";
  }
  $("#redirect").hidden = false;
  const answer = accept => async () => leave(await post("/oauth2/consent", { accept }), "The agent did not get an answer. Start again from your agent.");
  button("Deny", answer(false), true);
  button("Allow", answer(true));
}
main();
`

const styles = `
:root { color-scheme: light dark; --text: #171717; --muted: #666; --line: #e5e5e5; --surface: #fff; --page: #fafafa; --accent: #171717; --accent-text: #fff; }
@media (prefers-color-scheme: dark) { :root { --text: #ededed; --muted: #a1a1a1; --line: #2e2e2e; --surface: #111; --page: #0a0a0a; --accent: #ededed; --accent-text: #0a0a0a; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--page); color: var(--text); font: 15px/1.5 Geist, ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
main { width: 100%; max-width: 400px; display: grid; gap: 16px; }
svg { width: 22px; height: 20px; }
h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; text-wrap: balance; }
p { margin: 0; color: var(--muted); }
code { font: 0.9em ui-monospace, monospace; color: var(--text); }
.panel { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.who { display: grid; flex: 1; min-width: 0; }
#email { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; }
.actions { display: grid; gap: 8px; }
button { height: 40px; padding: 0 16px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 500; cursor: pointer; }
button.secondary { background: transparent; color: var(--text); border-color: var(--line); }
button.link { height: auto; padding: 0; border: 0; background: none; color: var(--text); text-decoration: underline; text-underline-offset: 0.2em; }
button:disabled { opacity: 0.6; cursor: default; }
button:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
.note { font-size: 13px; }
[role=alert] { color: #e5484d; font-size: 13px; }
a { color: var(--text); text-underline-offset: 0.2em; }
[hidden] { display: none !important; }
`

/** The `/oauth` page. Its script runs with a nonce, and it sends requests only to the Console origin. */
export function renderOAuthPage(): Response {
  const nonce = crypto.randomUUID()
  const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title>Connect an agent · ViteHub Console</title>
    <style>${styles}</style>
  </head>
  <body>
    <main>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 18" aria-hidden="true"><path fill="currentColor" d="M19.734 8.156 15.576.844A1.66 1.66 0 0 0 14.135 0H5.819C5.226 0 4.677.32 4.38.844L.222 8.156a1.71 1.71 0 0 0 0 1.688l4.158 7.312c.297.523.846.844 1.439.844h8.316c.593 0 1.142-.32 1.438-.844l4.158-7.312c.3-.523.3-1.165.003-1.688Z"/></svg>
      <h1>Connect an agent</h1>
      <p id="text">One moment.</p>
      <div id="account" class="panel" hidden>
        <span class="who"><span id="name"></span><span id="email"></span></span>
        <button id="switch" type="button" class="link">Switch account</button>
      </div>
      <p id="redirect" class="note" hidden></p>
      <div id="buttons" class="actions"></div>
      <p id="new" class="note" hidden>New to ViteHub? <a href="/" target="_blank" rel="noopener">Create an account</a>, then sign in here.</p>
      <p role="alert" hidden></p>
    </main>
    <script nonce="${nonce}">${script}</script>
  </body>
</html>`
  return new Response(page, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
  })
}
