import type { AiGatewayAsk } from "@vite-hub/gateways"
import type { ChoicesPlan, MultipleSelection, SingleSelection } from "./types.ts"

/** Internal protocol shared by the production and testing entries, even across package copies. */
export const resolveSelection = Symbol.for("vitehub.choices.resolveSelection")

export interface SelectionGateway {
  ask: AiGatewayAsk
  [resolveSelection]: (state: ChoicesPlan["state"], keys: readonly string[], context: unknown) => Promise<Record<string, MultipleSelection | SingleSelection> | undefined>
}
