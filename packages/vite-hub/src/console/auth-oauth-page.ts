import { consoleDocumentMetadata } from "./document-metadata.ts"
import { consoleStandaloneHeader, consoleStandaloneStyles } from "./standalone-page.ts"

/** How a person can sign in on the page: the social providers of the Auth, and its email and password sign-in. */
export interface ConsoleSignInMethods {
  providers: readonly { id: string, label: string }[]
  password: boolean
}

// Lucide icons for the access rows: eye, pencil, and refresh-cw.
const icons = {
  read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>',
  write: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>',
  offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
}

/**
 * The page where an MCP client's sign-in lands. Better Auth's OAuth provider sends both its login and its consent step
 * here with a signed query. Signed out, the person signs in and the provider resumes the authorization. Signed in, the
 * person sees the account, what the agent may do, and where the answer goes, then allows or denies the agent.
 */
export function consoleAuthOAuthPage(methods: ConsoleSignInMethods, authBase: string, consolePath: string): Response {
  const nonce = crypto.randomUUID()
  const literal = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c")
  const script = `
    const authBase = ${literal(authBase)};
    const providers = ${literal(methods.providers)};
    const consolePath = ${literal(consolePath)};
    const icons = ${literal(icons)};
    const params = new URLSearchParams(location.search);
    const $ = selector => document.querySelector(selector);
    const heading = $("h1");
    const text = $("#text");
    const buttons = $("#buttons");
    const form = $("form");
    const alertBox = $("[role=alert]");
    $(".site").textContent = location.host;
    // Only the parameters that the provider signed go back to it.
    const names = new Set(params.getAll("ba_param"));
    const signed = new URLSearchParams();
    for (const [key, value] of params) if (key === "sig" || key === "ba_param" || names.has(key)) signed.append(key, value);
    const oauthQuery = signed.toString();
    async function run(action) {
      const controls = document.querySelectorAll("button");
      for (const control of controls) control.disabled = true;
      alertBox.hidden = true;
      try { await action(); } catch (error) {
        alertBox.textContent = error instanceof Error ? error.message : "Something went wrong. Start again from your agent.";
        alertBox.hidden = false;
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
      return element;
    }
    function row(icon, label) {
      const element = document.createElement("div");
      element.className = "row";
      element.setAttribute("role", "listitem");
      element.innerHTML = icons[icon];
      const span = document.createElement("span");
      span.textContent = label;
      element.append(span);
      return element;
    }
    function leave(data, message) {
      const target = data.url || data.redirect_uri;
      if (!target) throw new Error(message);
      location.assign(target);
    }
    async function post(path, body) {
      const response = await fetch(authBase + path, {
        body: JSON.stringify({ ...body, oauth_query: oauthQuery }),
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error_description || data.message || "This link has expired. Start again from your agent.");
      return data;
    }
    const read = path => fetch(authBase + path, { credentials: "same-origin" }).then(response => response.ok ? response.json() : null).catch(() => null);
    async function main() {
      if (!oauthQuery.includes("sig=")) {
        heading.textContent = "This link has expired";
        text.textContent = "Start the connection again from your agent. It opens a fresh link.";
        return;
      }
      const clientId = params.get("client_id") || "";
      const [session, client] = await Promise.all([read("/get-session"), read("/oauth2/public-client?client_id=" + encodeURIComponent(clientId))]);
      const name = client && client.client_name ? client.client_name : "An agent";
      if (!session || !session.user) {
        heading.textContent = "Sign in to connect " + name;
        text.textContent = "Then choose whether it may use " + location.host + " as you.";
        if (form) {
          form.hidden = false;
          form.addEventListener("submit", (event) => {
            event.preventDefault();
            const fields = new FormData(form);
            run(async () => leave(await post("/sign-in/email", { email: fields.get("email"), password: fields.get("password"), rememberMe: true }), "Sign-in did not finish. Try again."));
          });
        }
        if (form && providers.length) buttons.classList.add("column");
        for (const provider of providers) {
          button("Continue with " + provider.label, async () => leave(await post("/sign-in/social", { callbackURL: consolePath, provider: provider.id }), "Sign-in did not start. Try again."), Boolean(form));
        }
        return;
      }
      heading.textContent = "Allow " + name + " to use " + location.host + "?";
      text.textContent = "It acts as you, with the Console sections you may use.";

      // The account the agent acts as, with a way to answer as someone else.
      const user = session.user;
      const label = user.name || user.email || "You";
      const initials = label.split(/\\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase();
      $("#avatar").textContent = initials;
      $("#name").textContent = label;
      if (user.email && user.email !== label) $("#email").textContent = user.email;
      else $("#email").remove();
      $("#switch").addEventListener("click", () => run(async () => {
        await fetch(authBase + "/sign-out", { body: "{}", credentials: "same-origin", headers: { "content-type": "application/json" }, method: "POST" });
        location.reload();
      }));
      $("#account").hidden = false;

      // What the agent asked for. vitehub:write is the scope of every tool that changes state.
      const scopes = new Set((params.get("scope") || "").split(" ").filter(Boolean));
      const grants = $("#grants");
      grants.append(row("read", "Read data in the sections you may use"));
      if (scopes.has("vitehub:write") || !scopes.has("vitehub:read")) grants.append(row("write", "Change, publish, and delete data in those sections"));
      if (scopes.has("offline_access")) grants.append(row("offline", "Stay connected without asking you again"));
      grants.hidden = false;

      // The answer goes to the agent's redirect address. Show its host, so a lookalike name does not hide where it goes.
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
  const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">${consoleDocumentMetadata}
    <title>Connect an agent · ViteHub Console</title>
    <style>${consoleStandaloneStyles}</style>
  </head>
  <body>
    <main>
      ${consoleStandaloneHeader("")}
      <h1>Connect an agent</h1>
      <p id="text">One moment.</p>
      <div class="stack">
        <div id="account" class="panel" hidden>
          <div class="row">
            <span id="avatar" class="avatar" aria-hidden="true"></span>
            <span class="who"><span id="name"></span><span id="email"></span></span>
            <button id="switch" type="button" class="link">Switch account</button>
          </div>
        </div>
        <div id="grants" class="panel" role="list" aria-label="What the agent may do" hidden></div>
        <p id="redirect" class="note" hidden></p>${methods.password
          ? `
        <form hidden>
          <label>Email <input name="email" type="email" autocomplete="email" required></label>
          <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
          <button type="submit">Sign in</button>
        </form>`
          : ""}
        <div id="buttons" class="actions"></div>
        <p role="alert" hidden></p>
      </div>
    </main>
    <script nonce="${nonce}">${script}</script>
  </body>
</html>`
  return new Response(page, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; img-src 'self' data:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
  })
}
