import { defineDiagnostics } from "nostics"
import { agentDocsBase, dynamicAgentError } from "./agent-diagnostic-options.ts"

// Keep message helpers independent of provider diagnostics and schema initialization.
export const messageDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: agentDocsBase,
  codes: {
    AGENT_R0646: {
      ...dynamicAgentError,
      fix: "Make the attachment fetchData() return a Blob, ArrayBuffer, Uint8Array, or string.",
    },
    AGENT_R0647: {
      ...dynamicAgentError,
      fix: "Give the message field that the message names a non-empty string.",
    },
    AGENT_R0648: {
      ...dynamicAgentError,
      fix: "Give the message field that the message names a value, or remove the field.",
    },
    AGENT_R0649: {
      ...dynamicAgentError,
      fix: "Give the message field that the message names a JSON value, not a function, symbol, or bigint.",
    },
    AGENT_R0650: {
      ...dynamicAgentError,
      fix: "Give the message field that the message names a finite number, not NaN or Infinity.",
    },
    AGENT_R0651: {
      ...dynamicAgentError,
      fix: "Convert the value that the message names to JSON before you store it, for example a Date with toISOString().",
    },
    AGENT_R0652: {
      ...dynamicAgentError,
      fix: "Give each message a role of \"user\", \"assistant\", \"system\", or \"tool\".",
    },
    AGENT_R0653: {
      ...dynamicAgentError,
      fix: "Give each message a parts array, such as parts: [{ type: \"text\", text: \"Hello\" }].",
    },
    AGENT_R0654: {
      ...dynamicAgentError,
      fix: "Give each text part a text string.",
    },
    AGENT_R0655: {
      ...dynamicAgentError,
      fix: "Set approved to true or false in each approval-decision part.",
    },
    AGENT_R0656: {
      ...dynamicAgentError,
      fix: "Put each approval-decision part after the approval-request part with the same id.",
    },
    AGENT_R0657: {
      ...dynamicAgentError,
      fix: "Put each tool-result part after the tool-call or approval-request part with the same id.",
    },
    AGENT_R0658: {
      ...dynamicAgentError,
      fix: "Give each data part a data field.",
    },
    AGENT_R0659: {
      ...dynamicAgentError,
      fix: "Give each attachment part a mediaType, such as \"image/png\".",
    },
    AGENT_R0660: {
      ...dynamicAgentError,
      fix: "Give each audio part an audio/* mediaType, such as \"audio/mpeg\".",
    },
    AGENT_R0661: {
      ...dynamicAgentError,
      fix: "Give each image part an image/* mediaType, such as \"image/png\".",
    },
    AGENT_R0662: {
      ...dynamicAgentError,
      fix: "Give each attachment part data, fetchData, or url.",
    },
    AGENT_R0663: {
      ...dynamicAgentError,
      fix: "Give each data part a data field.",
    },
    AGENT_R0664: {
      ...dynamicAgentError,
      fix: "Use only the message part types text, data, file, image, audio, source, error, tool-call, tool-result, approval-request, and approval-decision.",
    },
    AGENT_R0665: {
      ...dynamicAgentError,
      fix: "Resolve the fetchData() of each attachment to data, or remove it, before you call serializeMessages().",
    },
    AGENT_R0666: {
      ...dynamicAgentError,
      fix: "Convert binary attachment data to a string or a URL before you call serializeMessages().",
    },
    AGENT_R0667: {
      ...dynamicAgentError,
      fix: "Pass deserializeMessages() the string or object that serializeMessages() returned.",
    },
    AGENT_R0668: {
      ...dynamicAgentError,
      fix: "Pass deserializeMessages() the string or object that serializeMessages() returned, with message objects only.",
    },
  },
})
