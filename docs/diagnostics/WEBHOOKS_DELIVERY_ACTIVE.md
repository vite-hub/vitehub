---
description: "Wait for an active webhook delivery to finish before redelivering it, or flush a pending delivery to send it immediately."
---

`redeliverWebhookDelivery()` got a delivery that is `pending` or `sending`. Wait until it is sent, dead, or cancelled. To send a pending delivery now, flush it.
