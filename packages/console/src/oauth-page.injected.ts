const authBase = "/api/auth"

// The page runs in the browser, so its errors are plain: run() catches each one and shows its message in the alert.
// It sends only the parameters that the provider signed back to the provider.
export const oauthPageScript = `
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
  if (!response.ok) throw new Error(data.error_description || data.message || "This link has expired. Start again from your agent.");
  return data;
}
const read = path => fetch(path, { credentials: "same-origin" }).then(response => response.ok ? response.json() : null).catch(() => null);

async function signInWithPasskey() {
  const options = await read(${JSON.stringify(`${authBase}/passkey/generate-authenticate-options`)});
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
