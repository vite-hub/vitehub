/**
 * The page where an MCP client's sign-in lands. Better Auth's OAuth provider sends both its login and its consent step
 * here with a signed query. Signed out, the person signs in with the Console provider and the provider resumes the
 * authorization. Signed in, the person allows or denies the agent, and the page goes back to it.
 */
export function consoleAuthOAuthPage(provider: string, authBase: string, consolePath: string): Response {
  const label = provider.toLowerCase() === "github" ? "GitHub" : provider
  const nonce = crypto.randomUUID()
  const literal = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c")
  const script = `
    const authBase = ${literal(authBase)};
    const provider = ${literal(provider)};
    const consolePath = ${literal(consolePath)};
    const params = new URLSearchParams(location.search);
    const heading = document.querySelector("h1");
    const text = document.querySelector("#text");
    const buttons = document.querySelector("#buttons");
    const alertBox = document.querySelector("[role=alert]");
    // Only the parameters that the provider signed go back to it.
    const names = new Set(params.getAll("ba_param"));
    const signed = new URLSearchParams();
    for (const [key, value] of params) if (key === "sig" || key === "ba_param" || names.has(key)) signed.append(key, value);
    const oauthQuery = signed.toString();
    function button(label, onClick, secondary) {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = label;
      if (secondary) element.className = "secondary";
      element.addEventListener("click", async () => {
        for (const other of buttons.querySelectorAll("button")) other.disabled = true;
        alertBox.hidden = true;
        try { await onClick(); } catch (error) {
          alertBox.textContent = error instanceof Error ? error.message : "Something went wrong. Start again from your agent.";
          alertBox.hidden = false;
          for (const other of buttons.querySelectorAll("button")) other.disabled = false;
        }
      });
      buttons.append(element);
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
    async function main() {
      if (!oauthQuery.includes("sig=")) {
        heading.textContent = "This link has expired";
        text.textContent = "Start the connection again from your agent. It opens a fresh link.";
        return;
      }
      const session = await fetch(authBase + "/get-session", { credentials: "same-origin" }).then(response => response.ok ? response.json() : null).catch(() => null);
      if (!session || !session.user) {
        heading.textContent = "Connect an agent";
        text.textContent = "Sign in to choose whether it can use this app's operations.";
        button("Sign in with " + ${literal(label)}, async () => {
          const data = await post("/sign-in/social", { callbackURL: consolePath, provider });
          if (!data.url) throw new Error("Sign-in did not start. Try again.");
          location.assign(data.url);
        });
        return;
      }
      const clientId = params.get("client_id") || "";
      const client = await fetch(authBase + "/oauth2/public-client?client_id=" + encodeURIComponent(clientId), { credentials: "same-origin" }).then(response => response.ok ? response.json() : null).catch(() => null);
      const name = client && client.client_name ? client.client_name : "An agent";
      const who = session.user.email || session.user.name || "you";
      heading.textContent = "Allow " + name + " to use the Console?";
      text.textContent = "It acts as " + who + ": it can run the operations of this app in the Console sections you may use, read or change data, and delete or publish. Anyone can register an agent under any name, so allow it only if you started this connection.";
      const answer = accept => async () => {
        const data = await post("/oauth2/consent", { accept });
        const target = data.url || data.redirect_uri;
        if (!target) throw new Error("The agent did not get an answer. Start again from your agent.");
        location.assign(target);
      };
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
    <meta name="robots" content="noindex, nofollow">
    <title>Connect an agent · ViteHub Console</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { min-height: 100dvh; margin: 0; display: grid; place-items: center; background: light-dark(#fafafa, #0a0a0a); color: light-dark(#171717, #f5f5f5); }
      main { width: min(24rem, calc(100% - 3rem)); }
      h1 { margin: 0 0 .5rem; font-size: 1.5rem; font-weight: 600; }
      p { margin: 0 0 1.5rem; color: light-dark(#525252, #a3a3a3); line-height: 1.5; }
      #buttons { display: flex; gap: .5rem; }
      button { min-height: 2.5rem; padding: 0 1rem; border: 0; border-radius: .5rem; background: light-dark(#171717, #f5f5f5); color: light-dark(#fff, #171717); font: inherit; font-weight: 500; cursor: pointer; }
      button.secondary { background: transparent; color: inherit; outline: 1px solid light-dark(#d4d4d4, #404040); }
      button:disabled { opacity: .6; cursor: wait; }
      button:focus-visible { outline: 2px solid #3b82f6; outline-offset: 3px; }
      [role=alert] { margin-top: 1rem; color: light-dark(#b91c1c, #f87171); }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect an agent</h1>
      <p id="text">One moment.</p>
      <div id="buttons"></div>
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
