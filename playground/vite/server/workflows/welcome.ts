import { defineWorkflow } from "@vitehub/workflow"

export default defineWorkflow(async ({ payload }) => {
  const body = payload as { callbackUrl?: string, email?: string, marker?: string } | undefined

  if (body?.callbackUrl && body.marker) {
    await fetch(body.callbackUrl, {
      body: JSON.stringify({ marker: body.marker }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  }

  return {
    email: body?.email || "ava@example.com",
    marker: body?.marker,
    ok: true,
  }
})
