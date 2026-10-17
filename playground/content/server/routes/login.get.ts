import { defineHandler } from "h3"

import { playgroundPassword, playgroundUsers } from "../roles"

// A sign-in page for the playground users. Each button signs up the user once, then signs in.
export default defineHandler(() => new Response(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Sign in · Content playground</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 4rem auto; max-width: 28rem; padding: 0 1rem; }
  button { display: block; width: 100%; margin: .5rem 0; padding: .6rem; font: inherit; cursor: pointer; }
  output { color: #b91c1c; }
</style>
<h1>Content playground</h1>
<p>Sign in as one of the playground users, then open the Console.</p>
${Object.entries(playgroundUsers).map(([email, role]) => `<button data-email="${email}">Sign in as ${role} (${email})</button>`).join("\n")}
<output></output>
<script type="module">
  const password = ${JSON.stringify(playgroundPassword)}
  const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  for (const button of document.querySelectorAll("button")) {
    button.addEventListener("click", async () => {
      const email = button.dataset.email
      let response = await post("/api/auth/sign-in/email", { email, password })
      if (!response.ok) response = await post("/api/auth/sign-up/email", { email, password, name: email.split("@")[0] })
      if (response.ok) location.href = "/_vitehub/content"
      else document.querySelector("output").textContent = await response.text()
    })
  }
</script>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } }))
