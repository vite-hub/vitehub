/** Prefix of the provider default Chat State keys of one Agent. */
export function chatStateAgentPrefix(agentName: string): string {
  return `chat:${agentName}:`
}

/** Prefix of the provider default Chat State keys of one Channel of an Agent. */
export function chatStateChannelPrefix(agentName: string, origin: string): string {
  return `${chatStateAgentPrefix(agentName)}${origin}:`
}

/** The key that the provider default State stores for a Chat SDK key. User transcripts span the Channels of an Agent. */
export function chatStateScopedKey(key: string, agentPrefix: string, channelPrefix: string): string {
  return `${key.startsWith("transcripts:user:") ? agentPrefix : channelPrefix}${key}`
}
