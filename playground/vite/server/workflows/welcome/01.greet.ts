export default async function greet(input: { callbackUrl?: string, email?: string, marker?: string } | undefined) {
  if (input?.marker && input.callbackUrl) {
    const response = await fetch(input.callbackUrl, {
      body: JSON.stringify({ marker: input.marker, stage: "done" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    if (!response.ok) throw new Error(`Marker callback failed with ${response.status}.`)
  }
  return { email: input?.email || "ava@example.com", marker: input?.marker, ok: true }
}
