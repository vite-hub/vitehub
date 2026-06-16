# Chat App Routes Consume Chat Trigger

Superseded. ViteHub no longer exposes production Chat App Routes or the served HTTP chat helper surface.

The built-in DevTools chat remains the built-in chat UI for fast Agent learning and testing. The Chat Capability still contributes the shared `chat.message` Agent Trigger, and Chat Webhook Routes still consume that trigger for Chat Platform Adapters such as Teams.

Application chat UIs should own their HTTP route or transport and call the Agent Trigger API directly when they need to start a chat Agent Invocation. ViteHub should not carry a generated production chat UI transport unless a future decision reintroduces it with a smaller, clearer contract.
