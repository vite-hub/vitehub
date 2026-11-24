import { passkeyHelpers, renderStandalonePage } from "./oauth-page.ts"

const script = `
const $ = selector => document.querySelector(selector);
const page = document.querySelector("#page").dataset;
const heading = $("h1");
const text = $("#text");
const buttons = $("#buttons");
const alertBox = $("[role=alert]");
const here = location.pathname + location.search;
${passkeyHelpers}
function showError(message) {
  alertBox.textContent = message;
  alertBox.hidden = false;
}
async function run(action) {
  const controls = document.querySelectorAll("button");
  for (const control of controls) control.disabled = true;
  alertBox.hidden = true;
  try { await action(); } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotAllowedError")) {
      showError(error instanceof Error ? error.message : "Something went wrong. Try again.");
    }
  }
  for (const control of controls) control.disabled = false;
}
async function call(path, body) {
  const response = await fetch("/api/auth" + path, { body: JSON.stringify(body), credentials: "same-origin", headers: { "content-type": "application/json" }, method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    showError(data.message || "Sign-in did not finish. Try again.");
    return null;
  }
  return data;
}
function button(label, onClick, secondary) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (secondary) element.className = "secondary";
  element.addEventListener("click", () => run(onClick));
  buttons.append(element);
}
async function main() {
  if (page.state === "forbidden") {
    heading.textContent = "You cannot comment on " + page.site;
    text.textContent = "Your account is not in the team of this site. Switch to another account, or ask a member for an invite.";
    button("Switch account", async () => {
      if (await call("/sign-out", {})) location.reload();
    });
    return;
  }
  heading.textContent = "Sign in to comment on " + page.site;
  text.textContent = "Use your ViteHub Console account. A guest opens the invite link again.";
  const methods = await fetch("/api/sign-in-methods").then(response => response.ok ? response.json() : null).catch(() => null);
  if (methods && methods.github) button("Continue with GitHub", async () => {
    const data = await call("/sign-in/social", { provider: "github", callbackURL: here });
    if (data?.url) location.assign(data.url);
    else if (data) showError("Sign-in did not start. Try again.");
  });
  if (typeof window.PublicKeyCredential === "function") button("Sign in with a passkey", async () => {
    if (await call("/passkey/verify-authentication", { response: await passkeyAssertion() })) location.reload();
  }, Boolean(methods && methods.github));
}
main();
`

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, character => `&#${character.charCodeAt(0)};`)
}

/**
 * The page of `/comments/<project>/authorize` when the Console cannot give a code yet: a sign-in for a person who is
 * not signed in, or `forbidden` for an account that is not in the team of the site. After a sign-in, the page loads
 * the same authorize URL again.
 */
export function renderHostedCommentsSignIn(input: { site: string, state: "sign-in" | "forbidden" }): Response {
  const page = renderStandalonePage({
    title: "Comments",
    script,
    body: `      <h1>Comments</h1>
      <p id="text">One moment.</p>
      <div id="page" data-site="${escapeAttribute(input.site)}" data-state="${input.state}" hidden></div>
      <div id="buttons" class="actions"></div>
      <p role="alert" hidden></p>`,
  })
  return new Response(page.body, { headers: page.headers, status: input.state === "forbidden" ? 403 : 401 })
}
