import { passkeyHelpers } from "./oauth-page.ts"

/** Browser script for the CLI device approval page. */
export const deviceScript = `
const $ = selector => document.querySelector(selector);
const heading = $("h1");
const text = $("#text");
const alertBox = $("[role=alert]");
const form = $("#code-form");
const codeInput = $("#code");
const request = $("#request");
const buttons = $("#buttons");
const signIn = $("#sign-in");
const here = location.pathname + location.search;
${passkeyHelpers}
function show(message) {
  alertBox.textContent = message;
  alertBox.hidden = false;
}
async function run(action) {
  const controls = document.querySelectorAll("button, input, select");
  for (const control of controls) control.disabled = true;
  alertBox.hidden = true;
  try { await action(); } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotAllowedError")) show(error instanceof Error ? error.message : "Something went wrong. Try again.");
  }
  for (const control of controls) control.disabled = false;
}
async function call(path, init) {
  const response = await fetch("/api/auth" + path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init && init.headers) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.message || (data.error === "expired_token" ? "The code expired. Run vitehub login again." : "There is no such code. Check it in the terminal."));
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
function finish(title, message) {
  heading.textContent = title;
  text.textContent = message;
  form.hidden = true;
  request.hidden = true;
  buttons.replaceChildren();
}
async function review(code) {
  const answer = await call("/device?user_code=" + encodeURIComponent(code), { method: "GET" });
  if (answer.status !== "pending") return finish("This code was used", "Run vitehub login again for a new code.");
  const account = await fetch("/api/account", { credentials: "same-origin" }).then(response => response.ok ? response.json() : null).catch(() => null);
  const teams = account && Array.isArray(account.teams) ? account.teams : [];
  if (!teams.length) throw new Error("Your account has no team. Open the Console first.");
  const select = $("#team");
  select.replaceChildren(...teams.map(team => new Option(team.name, team.id, false, team.id === account.teamId)));
  $("#client").textContent = answer.client_name || "The ViteHub CLI";
  $("#code-shown").textContent = answer.user_code.length === 8 ? answer.user_code.slice(0, 4) + "-" + answer.user_code.slice(4) : answer.user_code;
  heading.textContent = "Sign in the ViteHub CLI?";
  text.textContent = "Check that the code matches the one in your terminal.";
  form.hidden = true;
  request.hidden = false;
  buttons.replaceChildren();
  button("Deny", async () => {
    await call("/device/deny", { method: "POST", body: JSON.stringify({ userCode: answer.user_code }) });
    finish("Denied", "The CLI did not get access. You can close this tab.");
  }, true);
  button("Approve", async () => {
    await call("/cli/approve", { method: "POST", body: JSON.stringify({ userCode: answer.user_code, teamId: select.value }) });
    finish("The CLI is signed in", "Go back to your terminal. You can revoke its key in Account settings, under API keys.");
  });
}
async function main() {
  const session = await fetch("/api/auth/get-session", { credentials: "same-origin" }).then(response => response.ok ? response.json() : null).catch(() => null);
  const code = new URLSearchParams(location.search).get("user_code") || "";
  if (!session || !session.user) {
    heading.textContent = "Sign in to connect the ViteHub CLI";
    text.textContent = "Then check the code from your terminal.";
    const methods = await fetch("/api/sign-in-methods").then(response => response.ok ? response.json() : null).catch(() => null);
    if (methods && methods.github) button("Continue with GitHub", async () => {
      const data = await call("/sign-in/social", { method: "POST", body: JSON.stringify({ provider: "github", callbackURL: here }) });
      if (!data.url) throw new Error("Sign-in did not start. Try again.");
      location.assign(data.url);
    });
    if (typeof window.PublicKeyCredential === "function") button("Sign in with a passkey", async () => {
      await call("/passkey/verify-authentication", { method: "POST", body: JSON.stringify({ response: await passkeyAssertion() }) });
      location.reload();
    }, Boolean(methods && methods.github));
    signIn.hidden = false;
    return;
  }
  heading.textContent = "Connect the ViteHub CLI";
  text.textContent = "Type the code that the CLI printed in your terminal.";
  form.hidden = false;
  codeInput.value = code;
  form.addEventListener("submit", event => {
    event.preventDefault();
    run(() => review(codeInput.value.trim()));
  });
  if (code) await run(() => review(code));
  else codeInput.focus();
}
main();
`
