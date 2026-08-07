import { createAuthClient } from "better-auth/vue"
import { computed } from "vue"

import type { SessionQueryParams } from "better-auth"
import type { BetterFetchError, VueAuthClient } from "better-auth/vue"
import type { ComputedRef, DeepReadonly, Ref } from "vue"

export { createAuthClient }
export type { VueAuthClient } from "better-auth/vue"

export const authClient: VueAuthClient<{}> = createAuthClient()

export function useAuthClient(): typeof authClient {
  return authClient
}

export interface AuthSessionState<Client extends VueAuthClient<any> = typeof authClient> {
  data: Client["$Infer"]["Session"] | null
  error: BetterFetchError | null
  isPending: boolean
  isRefetching: boolean
  refetch: (queryParams?: { query?: SessionQueryParams }) => Promise<void>
}

type AuthSessionRef<Client extends VueAuthClient<any> = typeof authClient> = DeepReadonly<Ref<AuthSessionState<Client>>>

export function useSession<Client extends VueAuthClient<any> = typeof authClient>(client: Client = authClient as Client): AuthSessionRef<Client> {
  return client.useSession() as AuthSessionRef<Client>
}

type ClientSession<Client extends VueAuthClient<any>> = Client["$Infer"]["Session"]

export interface UserSession<Client extends VueAuthClient<any> = typeof authClient> {
  data: ComputedRef<ClientSession<Client> | null>
  error: ComputedRef<BetterFetchError | null>
  loggedIn: ComputedRef<boolean>
  pending: ComputedRef<boolean>
  ready: ComputedRef<boolean>
  refresh: () => Promise<void>
  session: ComputedRef<ClientSession<Client>["session"] | null>
  signIn: Client["signIn"]
  signOut: Client["signOut"]
  signUp: Client["signUp"]
  user: ComputedRef<ClientSession<Client>["user"] | null>
}

export function useUserSession<Client extends VueAuthClient<any> = typeof authClient>(client: Client = authClient as Client): UserSession<Client> {
  const state = client.useSession() as AuthSessionRef<Client>
  return {
    data: computed(() => state.value.data),
    error: computed(() => state.value.error),
    loggedIn: computed(() => Boolean(state.value.data?.session && state.value.data?.user)),
    pending: computed(() => state.value.isPending || state.value.isRefetching),
    ready: computed(() => !state.value.isPending),
    refresh: () => state.value.refetch(),
    session: computed(() => state.value.data?.session ?? null),
    signIn: client.signIn,
    signOut: client.signOut,
    signUp: client.signUp,
    user: computed(() => state.value.data?.user ?? null),
  }
}

export function useSignIn(): typeof authClient.signIn {
  return authClient.signIn
}

export function useSignUp(): typeof authClient.signUp {
  return authClient.signUp
}
