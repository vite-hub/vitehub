import { useLogger } from "evlog/nitro/v3";
import { defineHandler } from "nitro/h3";
import { Diagnostic } from "nostics";

export default defineHandler((event) => {
  const logger = useLogger(event);
  const fail = new URL(event.req.url).searchParams.get("fail") === "1";
  logger.set({
    requestId: crypto.randomUUID(),
    message: fail ? "Payment provider unavailable" : "Checkout completed",
    customer: { id: "customer-demo", email: "private@example.test" },
    checkout: { orderId: "order-demo", amount: 2400, currency: "EUR" },
  });
  if (fail) {
    const diagnostic = new Diagnostic({
      code: "PAYMENT_UNAVAILABLE",
      why: "The sample payment provider is unavailable.",
      fix: "Retry without ?fail=1 to simulate a successful checkout.",
      docs: "https://vitehub.dev/docs/logs/limits-and-errors",
      data: { provider: "demo", retryable: true },
    });
    logger.set({ diagnostic: diagnostic.toJSON() });
    logger.error(diagnostic);
    return new Response(JSON.stringify({ error: diagnostic.code }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  return { orderId: "order-demo", status: "completed" };
});
