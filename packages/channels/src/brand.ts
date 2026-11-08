/** Marks the objects that `defineChannel()` returns. `@vite-hub/agent` reads it to tell a Channel from an adapter. */
export const channelDefinitionBrand: unique symbol = Symbol.for("vitehub.channel.definition")
