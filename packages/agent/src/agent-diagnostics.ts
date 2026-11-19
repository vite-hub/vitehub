import { defineDiagnostics } from "nostics"
import { isRuntimeDiagnostic } from "@vite-hub/runtime"
import { agentDiagnosticOptions, dynamicAgentError as dynamicError } from "./agent-diagnostic-options.ts"
import { messageDiagnostics } from "./message-diagnostics.ts"
import { formatUnknownAgentMessage } from "./registry-error.ts"

const agentTypeDiagnosticCodes = new Set([
  "AGENT_R1040",
  "AGENT_R1041",
  "AGENT_R1042",
  "AGENT_R1043",
  "AGENT_R1044",
  "AGENT_STORAGE_PREFIX_INVALID",
  "AGENT_STORAGE_PREFIX_OUTSIDE",
  "AGENT_R1007",
  "AGENT_R0981",
  "AGENT_R0982",
  "AGENT_R0983",
  "AGENT_R0923",
  "AGENT_R0921",
  "AGENT_R0920",
  "AGENT_R0919",
  "AGENT_R0917",
  "AGENT_R0916",
  "AGENT_R0914",
  "AGENT_R0911",
  "AGENT_R0910",
  "AGENT_R0907",
  "AGENT_R0906",
  // Instruction composition retains the input-error status of Markdown Template failures.
  "MARKDOWN_TEMPLATE_R0014",
  "MARKDOWN_TEMPLATE_R0018",
  "MARKDOWN_TEMPLATE_R0020",
  "AGENT_R0904",
  "AGENT_R0898",
  "AGENT_R0899",
  "AGENT_R0901",
  "AGENT_R0004",
  "AGENT_R0005",
  "AGENT_R0006",
  "AGENT_R0008",
  "AGENT_R0010",
  "AGENT_R0015",
  "AGENT_R0016",
  "AGENT_R0025",
  "AGENT_R0027",
  "AGENT_R0028",
  "AGENT_R0029",
  "AGENT_R0030",
  "AGENT_R0031",
  "AGENT_R0032",
  "AGENT_R0033",
  "AGENT_R0034",
  "AGENT_R0035",
  "AGENT_R0049",
  "AGENT_R0050",
  "AGENT_R0051",
  "AGENT_R0077",
  "AGENT_R0078",
  "AGENT_R0079",
  "AGENT_R0080",
  "AGENT_R0084",
  "AGENT_R0089",
  "AGENT_R0090",
  "AGENT_R0091",
  "AGENT_R0093",
  "AGENT_R0095",
  "AGENT_R0096",
  "AGENT_R0097",
  "AGENT_R0098",
  "AGENT_R0099",
  "AGENT_R0100",
  "AGENT_R0101",
  "AGENT_R0102",
  "AGENT_R0114",
  "AGENT_R0115",
  "AGENT_R0116",
  "AGENT_R0117",
  "AGENT_R0126",
  "AGENT_R0127",
  "AGENT_R0128",
  "AGENT_R0130",
  "AGENT_R0135",
  "AGENT_R0138",
  "AGENT_R0140",
  "AGENT_R0141",
  "AGENT_R0143",
  "AGENT_R0146",
  "AGENT_R0150",
  "AGENT_R0152",
  "AGENT_R0162",
  "AGENT_R0164",
  "AGENT_R0165",
  "AGENT_R0166",
  "AGENT_R0198",
  "AGENT_R0200",
  "AGENT_R0203",
  "AGENT_R0229",
  "AGENT_R0234",
  "AGENT_R0235",
  "AGENT_R0237",
  "AGENT_R0239",
  "AGENT_R0240",
  "AGENT_R0241",
  "AGENT_R0244",
  "AGENT_R0245",
  "AGENT_R0246",
  "AGENT_R0256",
  "AGENT_R0257",
  "AGENT_R0258",
  "AGENT_R0259",
  "AGENT_R0260",
  "AGENT_R0261",
  "AGENT_R0262",
  "AGENT_R0263",
  "AGENT_R0264",
  "AGENT_R0265",
  "AGENT_R0266",
  "AGENT_R0267",
  "AGENT_R0269",
  "AGENT_R0270",
  "AGENT_R0271",
  "AGENT_R0272",
  "AGENT_R0273",
  "AGENT_R0275",
  "AGENT_R0276",
  "AGENT_R0277",
  "AGENT_R0278",
  "AGENT_R0279",
  "AGENT_R0280",
  "AGENT_R0281",
  "AGENT_R0282",
  "AGENT_R0283",
  "AGENT_R0284",
  "AGENT_R0285",
  "AGENT_R0286",
  "AGENT_R0287",
  "AGENT_R0288",
  "AGENT_R0289",
  "AGENT_R0295",
  "AGENT_R0299",
  "AGENT_R0300",
  "AGENT_R0301",
  "AGENT_R0302",
  "AGENT_R0303",
  "AGENT_R0304",
  "AGENT_R0305",
  "AGENT_R0306",
  "AGENT_R0307",
  "AGENT_R0308",
  "AGENT_R0309",
  "AGENT_R0310",
  "AGENT_R0311",
  "AGENT_R0312",
  "AGENT_R0318",
  "AGENT_R0319",
  "AGENT_R0334",
  "AGENT_R0335",
  "AGENT_R0337",
  "AGENT_R0344",
  "AGENT_R0357",
  "AGENT_R0358",
  "AGENT_R0371",
  "AGENT_R0372",
  "AGENT_R0373",
  "AGENT_R0374",
  "AGENT_R0375",
  "AGENT_R0378",
  "AGENT_R0379",
  "AGENT_R0380",
  "AGENT_R0381",
  "AGENT_R0382",
  "AGENT_R0383",
  "AGENT_R0384",
  "AGENT_R0401",
  "AGENT_R0402",
  "AGENT_R0425",
  "AGENT_R0426",
  "AGENT_R0430",
  "AGENT_R0434",
  "AGENT_R0446",
  "AGENT_R0453",
  "AGENT_R0455",
  "AGENT_R0456",
  "AGENT_R0457",
  "AGENT_R0458",
  "AGENT_R0459",
  "AGENT_R0460",
  "AGENT_R0461",
  "AGENT_R0462",
  "AGENT_R0463",
  "AGENT_R0464",
  "AGENT_R0465",
  "AGENT_R0466",
  "AGENT_R0467",
  "AGENT_R0468",
  "AGENT_R0469",
  "AGENT_R0470",
  "AGENT_R0471",
  "AGENT_R0472",
  "AGENT_R0473",
  "AGENT_R0474",
  "AGENT_R0475",
  "AGENT_R0476",
  "AGENT_R0477",
  "AGENT_R0478",
  "AGENT_R0479",
  "AGENT_R0480",
  "AGENT_R0481",
  "AGENT_R0482",
  "AGENT_R0483",
  "AGENT_R0484",
  "AGENT_R0485",
  "AGENT_R1038",
  "AGENT_R0486",
  "AGENT_R0487",
  "AGENT_R0488",
  "AGENT_R0489",
  "AGENT_R0491",
  "AGENT_R0494",
  "AGENT_R0495",
  "AGENT_R0496",
  "AGENT_R0932",
  "AGENT_R0937",
  "AGENT_R0933",
  "AGENT_R0939",
  "AGENT_R0942",
  "AGENT_R0943",
  "AGENT_R0945",
  "AGENT_R0501",
  "AGENT_R0508",
  "AGENT_R0509",
  "AGENT_R0510",
  "AGENT_R0512",
  "AGENT_R0513",
  "AGENT_R0514",
  "AGENT_R0516",
  "AGENT_R0518",
  "AGENT_R0521",
  "AGENT_R0522",
  "AGENT_R0523",
  "AGENT_R0527",
  "AGENT_R0528",
  "AGENT_R0529",
  "AGENT_R0535",
  "AGENT_R0536",
  "AGENT_R0537",
  "AGENT_R0538",
  "AGENT_R0539",
  "AGENT_R0540",
  "AGENT_R0541",
  "AGENT_R0542",
  "AGENT_R0543",
  "AGENT_R0544",
  "AGENT_R0547",
  "AGENT_R0548",
  "AGENT_R0549",
  "AGENT_R0550",
  "AGENT_R0551",
  "AGENT_R0557",
  "AGENT_R0558",
  "AGENT_R0559",
  "AGENT_R0560",
  "AGENT_R0561",
  "AGENT_R0562",
  "AGENT_R0564",
  "AGENT_R0565",
  "AGENT_R0569",
  "AGENT_R0570",
  "AGENT_R0571",
  "AGENT_R0582",
  "AGENT_R0586",
  "AGENT_R0587",
  "AGENT_R0588",
  "AGENT_R0589",
  "AGENT_R0590",
  "AGENT_R0591",
  "AGENT_R0593",
  "AGENT_R0595",
  "AGENT_R0596",
  "AGENT_R0597",
  "AGENT_R0598",
  "AGENT_R0599",
  "AGENT_R0601",
  "AGENT_R0604",
  "AGENT_R0605",
  "AGENT_R0607",
  "AGENT_R0609",
  "AGENT_R0610",
  "AGENT_R0611",
  "AGENT_R0612",
  "AGENT_R0613",
  "AGENT_R0614",
  "AGENT_R0615",
  "AGENT_R0616",
  "AGENT_R0618",
  "AGENT_R0619",
  "AGENT_R0620",
  "AGENT_R0621",
  "AGENT_R0622",
  "AGENT_R0623",
  "AGENT_R0624",
  "AGENT_R0625",
  "AGENT_R0626",
  "AGENT_R0627",
  "AGENT_R0629",
  "AGENT_R0630",
  "AGENT_R0631",
  "AGENT_R0632",
  "AGENT_R0633",
  "AGENT_R0635",
  "AGENT_R0636",
  "AGENT_R0637",
  "AGENT_R0638",
  "AGENT_R0639",
  "AGENT_R0641",
  "AGENT_R0642",
  "AGENT_R0646",
  "AGENT_R0647",
  "AGENT_R0648",
  "AGENT_R0649",
  "AGENT_R0650",
  "AGENT_R0651",
  "AGENT_R0652",
  "AGENT_R0653",
  "AGENT_R0654",
  "AGENT_R0655",
  "AGENT_R0656",
  "AGENT_R0657",
  "AGENT_R0658",
  "AGENT_R0659",
  "AGENT_R0660",
  "AGENT_R0661",
  "AGENT_R0662",
  "AGENT_R0663",
  "AGENT_R0664",
  "AGENT_R0665",
  "AGENT_R0666",
  "AGENT_R0667",
  "AGENT_R0668",
  "AGENT_R0672",
  "AGENT_R0673",
  "AGENT_R0674",
  "AGENT_R0675",
  "AGENT_R0696",
  "AGENT_R0697",
  "AGENT_R0698",
  "AGENT_R0703",
  "AGENT_R0704",
  "AGENT_R0708",
  "AGENT_R0711",
  "AGENT_R0713",
  "AGENT_R0714",
  "AGENT_R0715",
  "AGENT_R0716",
  "AGENT_R0727",
  "AGENT_R0728",
  "AGENT_R0729",
  "AGENT_R0730",
  "AGENT_R0731",
  "AGENT_R0732",
  "AGENT_R0733",
  "AGENT_R0734",
  "AGENT_R0735",
  "AGENT_R0736",
  "AGENT_R0737",
  "AGENT_R0738",
  "AGENT_R0739",
  "AGENT_R0740",
  "AGENT_R0741",
  "AGENT_R0744",
  "AGENT_R0768",
  "AGENT_R0773",
  "AGENT_R0776",
  "AGENT_R0840",
  "AGENT_R0841",
  "AGENT_R0845",
  "AGENT_R0868",
  "AGENT_R0869",
  "AGENT_B0005",
  "AGENT_B0006",
  "AGENT_B0016",
  "AGENT_B0024",
  "AGENT_B0017",
  "AGENT_R0878",
  "AGENT_R0879",
  "AGENT_R0880",
  "AGENT_R0881",
  "AGENT_R0882",
  "AGENT_R0886",
  "AGENT_R0888",
  "AGENT_R0926",
  "AGENT_R0927",
  "AGENT_R0970",
  "AGENT_R0971",
  "AGENT_R0976",
  "AGENT_R0936",
  "AGENT_R0935",
  "AGENT_R0924",
  "AGENT_R0925",
  "AGENT_R0929",
  "AGENT_R0938",
  "AGENT_R1039",
  // Named codes that replace TypeErrors keep their input-error status.
  "AGENT_BUDGET_CAPACITY_UNSUPPORTED",
  "AGENT_BUDGET_LIMIT_INVALID",
  "AGENT_BUDGET_LIMIT_MISSING",
  "AGENT_BUDGET_USD_INVALID",
  "AGENT_CAPABILITY_EXTEND_ID_CHANGED",
  "AGENT_CAPABILITY_ID_MISSING",
  "AGENT_CHANNEL_DELIVERY_CHANNEL_INVALID",
  "AGENT_CHANNEL_DELIVERY_FORMAT_EMPTY",
  "AGENT_CHANNEL_DELIVERY_MAX_CALLS_INVALID",
  "AGENT_CHANNEL_DELIVERY_MESSAGE_MISSING",
  "AGENT_CHANNEL_DELIVERY_REMINDER_INSTRUCTION_INVALID",
  "AGENT_CHANNEL_DELIVERY_REMINDER_NOT_REQUIRED",
  "AGENT_CHANNEL_DELIVERY_REMINDER_TURNS_INVALID",
  "AGENT_CHANNEL_PULL_OPTIONS_INVALID",
  "AGENT_CHANNEL_PULL_PAGE_INVALID",
  "AGENT_CHANNEL_SKIP_REPLY_REASON_MISSING",
  "AGENT_CHANNEL_STATE_DURATION_INVALID",
  "AGENT_CHANNEL_STATE_TRANSACTION_INVALID",
  "AGENT_CHANNEL_STATE_TRANSACTION_NESTED",
  "AGENT_CHANNEL_TASK_HANDLED",
  "AGENT_CONFIGURED_OPTIONS_INVALID",
  "AGENT_CONFIGURE_RESULT_INVALID",
  "AGENT_CONFIG_KEY_INVALID",
  "AGENT_CONNECTOR_ADAPTER_UNSUPPORTED",
  "AGENT_CONNECTOR_RECIPIENT_INVALID",
  "AGENT_CONNECTOR_RECIPIENT_MISSING",
  "AGENT_CONNECTOR_REPLACE_INVALID",
  "AGENT_CONNECTOR_REPLACE_THREAD_ROOT",
  "AGENT_CONNECTOR_THREAD_KEY_MISSING",
  "AGENT_CONNECTOR_THREAD_RECIPIENT_INVALID",
  "AGENT_CONNECTOR_THREAD_UNSUPPORTED",
  "AGENT_CUSTOM_INSTRUCTIONS_NOT_STRING",
  "AGENT_CUSTOM_INSTRUCTIONS_REFERENCE_INVALID",
  "AGENT_CUSTOM_INSTRUCTIONS_SLOT_MISSING",
  "AGENT_DISPATCH_DRY_RUN_WITH_QUEUE",
  "AGENT_DISPATCH_ITEMS_INVALID",
  "AGENT_DISPATCH_ITEM_KEY_MISSING",
  "AGENT_DISPATCH_ITEM_ORDER_INVALID",
  "AGENT_DISPATCH_QUEUE_OWNERSHIP_INVALID",
  "AGENT_DRAIN_MS_INVALID",
  "AGENT_EXTENDS_INVALID",
  "AGENT_INSTRUCTIONS_EXTEND_INVALID",
  "AGENT_INSTRUCTION_SLOT_INVALID",
  "AGENT_INVOCATIONS_DATABASE_DRIVER_UNSUPPORTED",
  "AGENT_INVOCATIONS_DATABASE_WITHOUT_STORE",
  "AGENT_MCP_BEARER_TOKEN_RENAMED",
  "AGENT_MCP_RETRIES_INVALID",
  "AGENT_MCP_TOOLS_LIST_INVALID",
  "AGENT_OBSERVABILITY_INSTALLED",
  "AGENT_OBSERVABILITY_MAX_PENDING_INVALID",
  "AGENT_OPENAPI_CONNECTION_BODY_INVALID",
  "AGENT_PAPERCUTS_BACKEND_MISSING",
  "AGENT_PAPERCUTS_CLI_INVALID",
  "AGENT_PAPERCUTS_DEDUPE_INVALID",
  "AGENT_PAPERCUT_DELIVERY_INVALID",
  "AGENT_PAPERCUT_IDENTITY_MISSING",
  "AGENT_PAPERCUT_INDEX_OPTION_INVALID",
  "AGENT_PAPERCUT_INDEX_SIMILARITY_INVALID",
  "AGENT_PAPERCUT_INVALID",
  "AGENT_PAPERCUT_MESSAGE_MISSING",
  "AGENT_PAPERCUT_MESSAGE_TOO_LONG",
  "AGENT_POSTHOG_API_KEY_MISSING",
  "AGENT_POSTHOG_HOST_INVALID",
  "AGENT_POSTHOG_PAPERCUTS_API_KEY_MISSING",
  "AGENT_PRESET_OPTIONS_CONFLICT",
  "AGENT_PRESET_OPTIONS_INVALID",
  "AGENT_PRESET_OPTIONS_WITHOUT_CONFIGURE",
  "AGENT_PRESET_OPTION_UNSUPPORTED",
  "AGENT_PRESET_UNKNOWN",
  "AGENT_QUEUED_INPUT_NOT_JSON",
  "AGENT_SKILL_NAME_INVALID",
  "AGENT_SLACK_CONNECTOR_ADAPTER_MISSING",
  "AGENT_TASK_AGENT_NAME_MISSING",
  "AGENT_TIMER_DURATION_INVALID",
  "AGENT_TRIGGER_PREPARE_INVALID",
  "AGENT_TRIGGER_SERIALIZE_CONFLICT",
  "AGENT_TRIGGER_SERIALIZE_INVALID",
  "AGENT_TRIGGER_TASKS_INVALID",
  "AGENT_TRIGGER_TASK_INVALID",
  "AGENT_TRIGGER_TASK_UNKNOWN",
  "AGENT_UI_STREAM_MISSING",
  "AGENT_WEBHOOK_STATE_SCOPE_INVALID",
  // The named codes that replace AGENT_R0930 and AGENT_R0940 keep their input-error status.
  "AGENT_CHANNEL_HISTORY_INVALID",
  "AGENT_CHANNEL_HISTORY_TRIGGER_UNKNOWN",
  "AGENT_CHANNEL_MESSAGE_INVALID",
  "AGENT_CHANNEL_MESSAGE_METHOD_INVALID",
  "AGENT_CHANNEL_ON_ADAPTER_UNSUPPORTED",
  "AGENT_CHANNEL_ON_TRIGGER_NAME_TAKEN",
  "AGENT_CHANNEL_ON_WEBHOOK_TRIGGER",
  "AGENT_GMAIL_AGENT_AMBIGUOUS",
  "AGENT_GMAIL_AGENT_MISSING",
  "AGENT_GMAIL_CHANNEL_EXPECTED",
  "AGENT_GMAIL_LABEL_MISSING",
  "AGENT_GMAIL_OPTIONS_INVALID",
  "AGENT_GMAIL_POLL_HOST_MISSING",
  "AGENT_INVOCATIONS_DURATION_INVALID",
  "AGENT_INVOCATIONS_PRUNE_CUTOFF_INVALID",
  "AGENT_INVOCATIONS_SIZE_INVALID",
])

// Throw-only diagnostics. The CLI and model adapters choose how to report them.
const agentDiagnosticHandles = defineDiagnostics({
  ...agentDiagnosticOptions,
  codes: {
    // AGENT_R0081, AGENT_R0085, AGENT_R0086, AGENT_R0088, AGENT_R0094, AGENT_R0109, and AGENT_R0153 through AGENT_R0155 are retired. Nothing raised them. AGENT_R0105, AGENT_R0106, and AGENT_R0151 are retired: only a ViteHub bug reached them. Do not reuse them.
    // AGENT_R0038 through AGENT_R0048, AGENT_R0889, and AGENT_R0922 are retired. Nothing raised them. Do not reuse them.
    AGENT_R0907: {
      ...dynamicError,
      fix: "Set the observations option of the Agent Invocation journal to whole numbers inside the range that the message names, or remove the option to use its default.",
    },
    AGENT_R0908: {
      ...dynamicError,
      fix: "Raise observations.maxBytes in the Agent Invocation journal options (at most 64 MiB), or keep fewer or smaller observations.",
    },
    AGENT_R0909: {
      ...dynamicError,
      fix: "Raise observations.maxBytes in the Agent Invocation journal options (at most 64 MiB), or append smaller observations.",
    },
    AGENT_R0910: {
      ...dynamicError,
      fix: "Set tablePrefix of createD1AgentInvocationStore() to letters, digits, and underscores that start with a letter or an underscore, such as \"vitehub_agent_\".",
    },
    AGENT_R0911: {
      ...dynamicError,
      fix: "Set the D1 Agent Invocation retention to maxAge and maxRecords values that the message accepts, and remove maxSize: D1 reports only the size of the whole database.",
    },
    AGENT_R0912: {
      ...dynamicError,
      fix: "Append smaller observations, or use an Agent Invocation store other than D1: a D1 row keeps at most 1 MB of observations.",
    },
    AGENT_R0913: {
      ...dynamicError,
      fix: "Append smaller observations or store less metadata, or use an Agent Invocation store other than D1: a D1 row is at most 2 MB.",
    },
    AGENT_R0914: {
      ...dynamicError,
      fix: "Store less Invocation metadata, or use an Agent Invocation store other than D1: a D1 row is at most 2 MB.",
    },
    AGENT_R0915: {
      ...dynamicError,
      fix: "Raise maxAge or maxRecords in the D1 Agent Invocation retention, or start a new Invocation. Retention deleted this record while the update ran.",
    },
    AGENT_R0916: {
      ...dynamicError,
      fix: "Pass leaseMs to store.claim() as a positive whole number of milliseconds.",
    },
    AGENT_R0917: {
      ...dynamicError,
      fix: "Pass a claimId of at most 512 UTF-8 bytes to store.claim().",
    },
    AGENT_R0918: {
      ...dynamicError,
      fix: "Retry the update. If it fails again, send fewer concurrent writes to the same Invocation.",
    },
    AGENT_R0919: {
      ...dynamicError,
      fix: "Pass list({ limit }) as a positive whole number inside the limit that the message names, or omit it.",
    },
    AGENT_R0920: {
      ...dynamicError,
      fix: "Pass the cursor that the last list() result returned, without changes, or omit it to read the first page.",
    },
    AGENT_R0921: {
      ...dynamicError,
      fix: "Shorten list({ search }) to the length that the message names.",
    },
    AGENT_R0923: {
      why: ({ names }: { names: string[] }) => `[vitehub] A tool transform removed MCP tools and introduced ${names.map(name => JSON.stringify(name)).join(", ")} without MCP provenance.`,
      fix: "Preserve metadata.mcpServer and metadata.originalName when renaming MCP tools. Use context.tools.add() to contribute unrelated tools and a transform to remove MCP tools.",
    },
    AGENT_R0905: {
      ...dynamicError,
      fix: "Run the Codex Driver with driver.credentials on Linux or macOS, or remove driver.credentials and sign in to Codex on this host.",
    },
    AGENT_R0906: {
      ...dynamicError,
      fix: "Remove CODEX_HOME from driver.env and from the Driver gateway environment, or remove driver.credentials.",
    },
    AGENT_R0903: {
      ...dynamicError,
      fix: "Check that the server can reach the Models.dev catalog or the catalogUrl of modelsDevPricing(), and retry later. To stop the request, pass usage({ pricing: false }) or your own pricing.",
    },
    AGENT_R0904: {
      ...dynamicError,
      fix: "Set modelsDevPricing({ catalogUrl }) to a URL that returns the Models.dev JSON object, or remove catalogUrl to use the default catalog.",
    },
    AGENT_R0898: {
      ...dynamicError,
      fix: "Pass appendObservation or observation to store.update(), not both in the same call.",
    },
    AGENT_R0899: {
      ...dynamicError,
      fix: "Append observations with journal.appendObservation(id, event, { id }), so that each observation has a stable id.",
    },
    AGENT_R0900: {
      ...dynamicError,
      fix: "Raise observations.maxCount in the Agent Invocation journal options, or append fewer observations to this Invocation.",
    },
    AGENT_R0901: {
      ...dynamicError,
      fix: "Pass appendObservation(id, event, { id }) an observation id of at most 512 characters.",
    },
    AGENT_R0902: {
      ...dynamicError,
      fix: "Make the update() method of the custom Agent Invocation store save appendObservation, then retry the append.",
    },
    AGENT_R0890: {
      ...dynamicError,
      fix: "Read error.cause for the error of the Capability telemetry export, and fix the exporter endpoint or credentials of the Capability that the message names. The Agent run result does not change.",
    },
    AGENT_R0891: {
      ...dynamicError,
      fix: "Read the HTTP status and the message: send the request body, headers, signature, and route that the Agent HTTP API expects, or for a 5xx status fix the server setting that the message names.",
    },
    // AGENT_R0892 is retired with Runtime Schedule targets. Do not reuse it.
    AGENT_R0893: {
      ...dynamicError,
      fix: "Set VITEHUB_AGENT_STATE_URL to a durable libSQL URL, or set agent.providers.state in vitehub().",
    },
    AGENT_R0894: {
      ...dynamicError,
      fix: "Set VITEHUB_AGENT_STATE_URL to a remote libSQL URL, such as a Turso URL. The filesystem of this host is not durable.",
    },
    AGENT_R0895: {
      ...dynamicError,
      fix: "Export the result of defineAgent() as the default export of the Agent file, then build again.",
    },
    AGENT_R0896: {
      ...dynamicError,
      fix: "Check the Discord bot token and the Discord Channel options of the Agent. The listener logs the failure and tries again, so a short Discord outage needs no change.",
    },
    AGENT_R0897: {
      ...dynamicError,
      fix: "Pass --port to the Deno Provider Output as a whole number from 0 to 65535.",
    },
    AGENT_R0004: {
      ...dynamicError,
      fix: "Pass the message through a model-backed Agent Driver, or give the attachment an HTTPS URL in place of the Blob.",
    },
    AGENT_R0005: {
      ...dynamicError,
      fix: "Pass the message through a model-backed Agent Driver, or give the attachment an HTTPS URL in place of the fetchData() callback.",
    },
    AGENT_R0006: {
      ...dynamicError,
      fix: "Set aiSdk({ execution: { attachments: { maxBytes } } }) to a positive number of bytes, or remove maxBytes to use the default.",
    },
    AGENT_R0007: {
      ...dynamicError,
      fix: "Send a smaller attachment, or raise aiSdk({ execution: { attachments: { maxBytes } } }).",
    },
    AGENT_R0008: {
      ...dynamicError,
      fix: "Make the fetchData() function of the attachment return non-empty data: a string, an ArrayBuffer, a Uint8Array, or a Blob.",
    },
    AGENT_R0009: {
      ...dynamicError,
      fix: "Read error.cause for the diagnostic of the tool, and apply the fix that it carries.",
    },
    AGENT_R0010: {
      ...dynamicError,
      fix: "Set driver.output.maxAttempts in defineAgent() to a positive whole number, or remove it to use 3.",
    },
    AGENT_R0011: {
      ...dynamicError,
      fix: "Throw an Error object, not another value, from the output schema of the Agent and from the model adapter.",
    },
    AGENT_R0012: {
      ...dynamicError,
      fix: "Throw an Error object, not another value, from the output schema of the Agent and from the model adapter.",
    },
    AGENT_R0013: {
      ...dynamicError,
      fix: "Throw an Error object, not another value, from the output schema of the Agent and from the model adapter.",
    },
    AGENT_R0014: {
      ...dynamicError,
      fix: "Add access() to defineAgent({ capabilities }) and let the Agent run it. Do not call its prepare() hook yourself.",
    },
    AGENT_R0015: {
      ...dynamicError,
      fix: "Pass an options object to access(), such as access({ workspace: { ... } }) or access({ chat: { ... } }).",
    },
    AGENT_R0016: {
      ...dynamicError,
      fix: "Pass chat, workspace, or both to access().",
    },
    AGENT_R0017: {
      ...dynamicError,
      fix: "Give the Agent a Workspace with defineAgent({ workspace }), or remove workspace from access().",
    },
    AGENT_R0018: {
      ...dynamicError,
      fix: "Use a Provider Agent Driver with access({ workspace }) in write mode, or set the Workspace mode to \"read\".",
    },
    AGENT_R0019: {
      ...dynamicError,
      fix: "Set defaultScope in access({ workspace }), or make its resolve() function return a Workspace Scope name.",
    },
    AGENT_R0020: {
      ...dynamicError,
      fix: "Give the caller the admin role for this Workspace Scope, or select a Scope without all: true.",
    },
    AGENT_R0021: {
      ...dynamicError,
      fix: "Add a Workspace Definition with the Source that the grant names, or remove the Source grant from the Workspace Scope.",
    },
    AGENT_R0022: {
      ...dynamicError,
      fix: "Use a relative Workspace Scope path without \"..\" or \".\" parts, such as \"docs/guides\".",
    },
    AGENT_R0023: {
      ...dynamicError,
      fix: "Create the path in the Workspace, or fix the Workspace Scope path that the message names.",
    },
    AGENT_R0024: {
      ...dynamicError,
      fix: "Request a Source path inside the selected Workspace Scope that matches a Source target of the Workspace Definition, or add the target.",
    },
    AGENT_R0025: {
      ...dynamicError,
      fix: "Set browser({ runtime }) to \"managed\" or \"external\", and set command to one executable name only with runtime: \"external\".",
    },
    AGENT_R0026: {
      ...dynamicError,
      fix: "Use a Provider Agent Driver in the Agent that has browser(), or remove browser() from its Capabilities.",
    },
    AGENT_R0027: {
      ...dynamicError,
      fix: "Set the diagnostics() option that the message names to a positive number of milliseconds, at most 2147483647, or remove it.",
    },
    AGENT_R0028: {
      ...dynamicError,
      fix: "Set diagnostics({ peakStepBytes }) to a positive number of bytes, or remove it.",
    },
    AGENT_R0029: {
      ...dynamicError,
      fix: "Pass an options object to diagnostics(), or call it with no argument.",
    },
    AGENT_R0030: {
      ...dynamicError,
      fix: "Set diagnostics({ interval }) to a value equal to or less than diagnostics({ heartbeat }).",
    },
    AGENT_R0031: {
      ...dynamicError,
      fix: "Give the email_send field that the message names a non-empty string.",
    },
    AGENT_R0032: {
      ...dynamicError,
      fix: "Pass email_send a to value that is one email address or an array of email addresses.",
    },
    AGENT_R0033: {
      ...dynamicError,
      fix: "Pass email_send a to value that is one email address or an array of email addresses, with no empty item.",
    },
    AGENT_R0034: {
      ...dynamicError,
      fix: "Set email({ recipients }) to an array of email addresses, or remove it.",
    },
    AGENT_R0035: {
      ...dynamicError,
      fix: "Set email({ recipients }) to an array of email addresses, with no empty item.",
    },
    AGENT_R0036: {
      ...dynamicError,
      fix: "Send to an address in email({ recipients }), or add the address to that list.",
    },
    AGENT_R0037: {
      ...dynamicError,
      fix: "Set email in vitehub(), such as email: { driver: \"resend\" }, so that the Agent gets an Email client with send().",
    },
    AGENT_R0049: {
      ...dynamicError,
      fix: "Set the responseType of the fetch() tool to \"json\" or \"text\".",
    },
    AGENT_R0050: {
      ...dynamicError,
      fix: "Pass fetch({ tools }) at least one named tool, such as tools: { weather: { url: \"https://...\" } }.",
    },
    AGENT_R0051: {
      ...dynamicError,
      fix: "Give the fetch() tool a url, or make its request function return an object with a url.",
    },
    AGENT_R0052: {
      ...dynamicError,
      fix: "Start the git() command with git, such as git status.",
    },
    AGENT_R0053: {
      ...dynamicError,
      fix: "Give the git() command a subcommand, such as git status.",
    },
    AGENT_R0054: {
      ...dynamicError,
      fix: "Remove the git flags before the subcommand, and pass the repository folder with the cwd option of the tool.",
    },
    AGENT_R0055: {
      ...dynamicError,
      fix: "Run one git command per tool call, without |, ;, <, >, &, or a new line.",
    },
    AGENT_R0056: {
      ...dynamicError,
      fix: "Close each quote in the git() command.",
    },
    AGENT_R0057: {
      ...dynamicError,
      fix: "Use a git subcommand that git() allows. The message names the subcommand that it blocks.",
    },
    AGENT_R0058: {
      ...dynamicError,
      fix: "Set git({ mode: \"write\" }) to allow this subcommand, or use a read subcommand, such as status, log, diff, or show.",
    },
    AGENT_R0059: {
      ...dynamicError,
      fix: "Remove --output from the git command. Read commands cannot write files.",
    },
    AGENT_R0060: {
      ...dynamicError,
      fix: "Remove the git option that the message names from the read command.",
    },
    AGENT_R0061: {
      ...dynamicError,
      fix: "Fetch from a remote name that git remote shows, such as origin, not from a URL.",
    },
    AGENT_R0062: {
      ...dynamicError,
      fix: "Use paths inside the Workspace in git arguments, without \"..\", \"~/\", or a leading \"/\".",
    },
    AGENT_R0063: {
      ...dynamicError,
      fix: "Remove the git option that the message names from the command.",
    },
    AGENT_R0064: {
      ...dynamicError,
      fix: "Remove the git fetch option that the message names from the command.",
    },
    AGENT_R0065: {
      ...dynamicError,
      fix: "Fetch a remote ref without + and without a :<destination> part, such as git fetch origin main.",
    },
    AGENT_R0066: {
      ...dynamicError,
      fix: "Make sure that the cwd of the git() tool is a git repository. The message shows the output of git remote.",
    },
    AGENT_R0067: {
      ...dynamicError,
      fix: "Fetch from a remote name that git remote shows, such as origin, or add the remote to the repository first.",
    },
    AGENT_R0068: {
      ...dynamicError,
      fix: "Set the cwd of the git() tool to a folder inside /workspace, without \"..\" or \".\" parts.",
    },
    AGENT_R0069: {
      ...dynamicError,
      fix: "Send a pull request event with head.sha, and with head.repo when it names a head branch, as GitHub pull_request events do.",
    },
    AGENT_R0070: {
      ...dynamicError,
      fix: "Delete the existing pull request checkout folder in the Workspace, or mount the pull request at an empty path, so that ViteHub clones it again. Do not change the remotes or branch settings of a checkout that ViteHub made.",
    },
    AGENT_R0071: {
      ...dynamicError,
      fix: "Read the git output in the message. Check that the Workspace can reach github.com and that the GitHub token can read the repository, then retry.",
    },
    AGENT_R0072: {
      ...dynamicError,
      fix: "Make sure that the cwd of the git() tool is a git repository. The message shows the output of git status.",
    },
    AGENT_R0073: {
      ...dynamicError,
      fix: "Commit or discard the changes in the working tree, then run the git write command again.",
    },
    AGENT_R0074: {
      ...dynamicError,
      fix: "Pass the git() tool a non-empty command string, such as git status.",
    },
    AGENT_R0075: {
      ...dynamicError,
      fix: "Give the Agent a Workspace that can start a shell session in defineAgent({ workspace }), or remove git().",
    },
    AGENT_R0076: {
      ...dynamicError,
      fix: "Give the Agent a Workspace that can start a shell session in defineAgent({ workspace }), or remove git().",
    },
    AGENT_R0077: {
      ...dynamicError,
      fix: "Pass gmail_draft valid email addresses, such as name@example.com, without <, >, or control characters.",
    },
    AGENT_R0078: {
      ...dynamicError,
      fix: "Give the gmail_draft field that the message names one line of non-empty text.",
    },
    AGENT_R0079: {
      ...dynamicError,
      fix: "Give gmail_draft a non-empty body.",
    },
    AGENT_R0080: {
      ...dynamicError,
      fix: "Set vitehub({ connections: true }), and run the Capability that the message names from a discovered Agent Definition with the ViteHub Connections primitive.",
    },
    AGENT_R0082: {
      ...dynamicError,
      fix: "Give the MCP server that the message names an http or sse transport without authProvider, and set its URL in transport.url or in the mcp endpoint of the Connection provider.",
    },
    AGENT_R0083: {
      ...dynamicError,
      fix: "Set the MCP server that the message names to a non-empty connection name, and set its channels to an array of Channel names or remove channels.",
    },
    AGENT_R0084: {
      ...dynamicError,
      fix: "Omit the subject when gmail_draft replies to a message, or use the subject of the original message.",
    },
    AGENT_R0087: {
      ...dynamicError,
      fix: "Reply with gmail_draft only to a message that has a Message-ID header, or send a new draft without a reply target.",
    },
    AGENT_R0089: {
      ...dynamicError,
      fix: "Pass gmail_search a max from 1 to 50, or omit it to use 10.",
    },
    AGENT_R0090: {
      ...dynamicError,
      fix: "Pass gmail_search a query string, or omit it to search the inbox.",
    },
    AGENT_R0091: {
      ...dynamicError,
      fix: "Remove null bytes from the gmail_search query.",
    },
    AGENT_R0092: {
      ...dynamicError,
      fix: "Check that the Gmail Connection calls the Gmail API and that its scopes allow the operation that the message names.",
    },
    AGENT_R0093: {
      ...dynamicError,
      fix: "Give gmail_draft at least one email address in the field that the message names.",
    },
    AGENT_R0095: {
      ...dynamicError,
      fix: "Pass gmail() only connection, a Connection name, and operations, a list of \"search\", \"read\", and \"draft\".",
    },
    AGENT_R0096: {
      ...dynamicError,
      fix: "Name each input command with lowercase letters, digits, - and _, starting with a letter, such as \"review\".",
    },
    AGENT_R0097: {
      ...dynamicError,
      fix: "Pass inputCommands({ commands }) an object that maps each command name to its command.",
    },
    AGENT_R0098: {
      ...dynamicError,
      fix: "Make each entry of inputCommands({ commands }) an object.",
    },
    AGENT_R0099: {
      ...dynamicError,
      fix: "Give the input command a non-empty description string, or remove description.",
    },
    AGENT_R0100: {
      ...dynamicError,
      fix: "Set the channels of the input command to an array of non-empty Channel IDs, or remove channels.",
    },
    AGENT_R0101: {
      ...dynamicError,
      fix: "Set inputCommands({ trigger }) to a non-empty string, such as \"/\", or remove it to use \"/\".",
    },
    AGENT_R0102: {
      ...dynamicError,
      fix: "Remove spaces and other whitespace from inputCommands({ trigger }).",
    },
    AGENT_R0103: {
      ...dynamicError,
      fix: "Change the input commands so that their expansions do not call each other in a loop or nest too deep.",
    },
    AGENT_R0104: {
      ...dynamicError,
      fix: "Enable the primitive that the message names in vitehub(). For the i18n() Capability, give the Agent agentI18n from vite-hub/i18n/server.",
    },
    // AGENT_R0107 and AGENT_R0108 are retired with llmGate() and llmRoute(). Do not reuse them.
    // AGENT_R0110 through AGENT_R0113 are retired with llmGate() and llmRoute(). Do not reuse them.
    AGENT_R0114: {
      ...dynamicError,
      fix: "Pass mcp({ integrity }) an object that maps each server name of mcp({ servers }) to its tool fingerprints.",
    },
    AGENT_R0115: {
      ...dynamicError,
      fix: "Use only server names from mcp({ servers }) as keys of mcp({ integrity }).",
    },
    AGENT_R0116: {
      ...dynamicError,
      fix: "Map each tool name to its fingerprint string for the server that the message names in mcp({ integrity }).",
    },
    AGENT_R0117: {
      ...dynamicError,
      fix: "Pass mcp({ servers }) an object that maps each server name to its config.",
    },
    AGENT_R0118: {
      ...dynamicError,
      fix: "Give the Agent a Workspace with write access in defineAgent({ workspace }), or use another memory store than workspaceJsonlMemoryStore().",
    },
    AGENT_R0119: {
      ...dynamicError,
      fix: "Give the Agent a Workspace in defineAgent({ workspace }), or use another memory store than workspaceJsonlMemoryStore().",
    },
    AGENT_R0120: {
      ...dynamicError,
      fix: "Give each memory() store a scope with at least one non-empty field, and remove retention from the store that the message names.",
    },
    AGENT_R0121: {
      ...dynamicError,
      fix: "Use a memory kind from the allowKinds of the store, or add the kind to allowKinds.",
    },
    AGENT_R0122: {
      ...dynamicError,
      fix: "Pass store with the name of the memory store to use. This Agent has more than one store.",
    },
    AGENT_R0123: {
      ...dynamicError,
      fix: "Pass the name of a store from memory({ stores }).",
    },
    AGENT_R0124: {
      ...dynamicError,
      fix: "Remove read.tools.read: false or read.tools.search: false from the memory store, or use a store that allows this tool.",
    },
    AGENT_R0125: {
      ...dynamicError,
      fix: "Set write: { mode: \"tool\" } on the memory store, or write to a store that has it.",
    },
    AGENT_R0126: {
      ...dynamicError,
      fix: "Pass openapi() an options object with spec, and set connection to a Connection name or remove it.",
    },
    AGENT_R0127: {
      ...dynamicError,
      fix: "Set openapi({ spec }) to the URL of an OpenAPI document or to the document object.",
    },
    AGENT_R0128: {
      ...dynamicError,
      fix: "Set openapi({ operations }) to a list of operationIds, or to an object that maps tool names to operationIds.",
    },
    AGENT_R0129: {
      ...dynamicError,
      fix: "Use an operationId from the OpenAPI document in openapi({ operations }), or add the operation to the document.",
    },
    AGENT_R0130: {
      ...dynamicError,
      fix: "Make openapi({ spec }) return the URL of an OpenAPI document or the document object.",
    },
    AGENT_R0131: {
      ...dynamicError,
      fix: "Set openapi({ spec }) to a URL that returns a JSON OpenAPI document, or pass the document object.",
    },
    AGENT_R0132: {
      ...dynamicError,
      fix: "Set openapi({ server }) to the base URL of the API, or add servers[0].url to the OpenAPI document.",
    },
    AGENT_R0133: {
      ...dynamicError,
      fix: "Remove the operation from openapi({ operations }), or use an operation with GET, HEAD, or POST.",
    },
    AGENT_R0134: {
      ...dynamicError,
      fix: "Give each operation in the OpenAPI document its own operationId.",
    },
    AGENT_R0135: {
      ...dynamicError,
      fix: "Use a tool name that starts with a letter and has only letters, digits, and underscores, by renaming the operationId or mapping a name in openapi({ operations }).",
    },
    AGENT_R0136: {
      ...dynamicError,
      fix: "Map each operation to its own command name in openapi({ operations }), so that no two operations make the same command.",
    },
    AGENT_R0137: {
      ...dynamicError,
      fix: "Send the request fields that the OpenAPI operation requires. The message lists the fields that are wrong.",
    },
    AGENT_R0138: {
      ...dynamicError,
      fix: "Pass the OpenAPI tool an object with path, query, and body fields.",
    },
    AGENT_R0139: {
      ...dynamicError,
      fix: "Remove the input fields that the message names, or put them in path, query, or body.",
    },
    AGENT_R0140: {
      ...dynamicError,
      fix: "Pass the path input of the OpenAPI tool as an object of path parameters.",
    },
    AGENT_R0141: {
      ...dynamicError,
      fix: "Pass the query input of the OpenAPI tool as an object of query parameters.",
    },
    AGENT_R0142: {
      ...dynamicError,
      fix: "Remove body from the input. This OpenAPI operation has no request body.",
    },
    AGENT_R0143: {
      ...dynamicError,
      fix: "Pass body as an object when the input also has body fields at the top level.",
    },
    AGENT_R0144: {
      ...dynamicError,
      fix: "Remove body from the input. This OpenAPI operation has no request body.",
    },
    AGENT_R0145: {
      ...dynamicError,
      fix: "Pass the path or query parameters that the message names.",
    },
    AGENT_R0146: {
      ...dynamicError,
      fix: "Pass the path or query input of the OpenAPI tool as an object.",
    },
    AGENT_R0147: {
      ...dynamicError,
      fix: "Remove the parameters that the message names. The OpenAPI operation does not declare them.",
    },
    AGENT_R0148: {
      ...dynamicError,
      fix: "Pass the parameter that the message names.",
    },
    AGENT_R0149: {
      ...dynamicError,
      fix: "Pass the path parameter that the message names.",
    },
    AGENT_R0150: {
      ...dynamicError,
      fix: "Set otlp({ endpoint }) to the OTLP base URL of the collector, such as \"https://otel.example.com\".",
    },
    AGENT_R0152: {
      ...dynamicError,
      fix: "Set otlp({ endpoint }) to an absolute http or https URL, such as \"https://otel.example.com\".",
    },
    AGENT_R0156: {
      ...dynamicError,
      fix: "Add progressSummary() to defineAgent({ capabilities }) and let the Agent run it. Do not call its hooks yourself.",
    },
    AGENT_R0157: {
      ...dynamicError,
      fix: "Add progressSummary() to defineAgent({ capabilities }) and let the Agent run it. Do not call its hooks yourself.",
    },
    AGENT_R0158: {
      ...dynamicError,
      fix: "Read the message for the error of the progressSummary({ driver }) run, and fix that Driver or its model settings.",
    },
    AGENT_R0159: {
      ...dynamicError,
      fix: "Make the rateLimit({ identity }) function return a non-empty value for each run, such as a user ID.",
    },
    AGENT_R0160: {
      ...dynamicError,
      fix: "Run the Agent through a Channel or route that gives run metadata, or use another rateLimit({ identity }).",
    },
    AGENT_R0161: {
      ...dynamicError,
      fix: "With rateLimit({ identity: \"ip\" }), set trustedIpHeaders to the headers that your host sets, such as [\"cf-connecting-ip\"]. With other identities, remove trustedIpHeaders.",
    },
    AGENT_R0162: {
      ...dynamicError,
      fix: "Pass rateLimit({ limiter }) a Rate Limiter from createRateLimiter() of vite-hub/rate-limit, or a function that returns one.",
    },
    AGENT_R0163: {
      ...dynamicError,
      fix: "Give each rateLimit() Capability of the Agent its own id, or remove the duplicate.",
    },
    AGENT_R0164: {
      ...dynamicError,
      fix: "Pass sandbox({ commands }) at least one executable name, such as [\"node\"].",
    },
    AGENT_R0165: {
      ...dynamicError,
      fix: "Pass sandbox({ commands }) only executable names, such as [\"node\", \"python3\"], without arguments or shell syntax.",
    },
    AGENT_R0166: {
      ...dynamicError,
      fix: "Pass sandbox_exec a command string.",
    },
    AGENT_R0167: {
      ...dynamicError,
      fix: "Run a command from sandbox({ commands }), or add the command to that list.",
    },
    AGENT_R0168: {
      ...dynamicError,
      fix: "Use a Sandbox driver that supports exec(), set in vitehub({ sandbox }).",
    },
    // AGENT_R0169 through AGENT_R0197 are retired with the schedule() Capability. Do not reuse them.
    AGENT_R0198: {
      ...dynamicError,
      fix: "Set skills({ shellExecution }) to \"read\" or \"write\", or remove it.",
    },
    AGENT_R0199: {
      ...dynamicError,
      fix: "Give the Agent a Workspace in defineAgent({ workspace }), or remove shellExecution from skills().",
    },
    AGENT_R0200: {
      ...dynamicError,
      fix: "Use a Blob asset path relative to the Workspace, without \"..\" or \".\" parts, such as \"images/chart.png\".",
    },
    AGENT_R0201: {
      ...dynamicError,
      fix: "Set vitehub({ blob: { serve: true } }), or use a Blob driver that returns a public URL.",
    },
    AGENT_R0202: {
      ...dynamicError,
      fix: "Use a Blob driver that returns absolute URLs, or publish Blob assets from an Agent run that started from an HTTP request.",
    },
    AGENT_R0203: {
      ...dynamicError,
      fix: "Pass the Blob list tool a limit that is a positive number, or omit it.",
    },
    AGENT_R0204: {
      ...dynamicError,
      fix: "Set blob in vitehub(), such as blob: true, or run pnpm add @vite-hub/blob in the app. The message shows the load error.",
    },
    AGENT_R0205: {
      ...dynamicError,
      fix: "Pass blob_edit a workspacePath of a file that exists in the active Workspace Session.",
    },
    AGENT_R0206: {
      ...dynamicError,
      fix: "Give the Agent a Workspace in defineAgent({ workspace }) to use blob_edit with workspacePath, or pass body or attachmentId.",
    },
    AGENT_R0207: {
      ...dynamicError,
      fix: "Pass blob_edit the attachmentId of one attachment of the current input. The message lists the IDs that you can use.",
    },
    AGENT_R0208: {
      ...dynamicError,
      fix: "Make the attachment that the message names hold data: a string, an ArrayBuffer, a Uint8Array, a Blob, or a fetchData() function that returns one.",
    },
    AGENT_R0209: {
      ...dynamicError,
      fix: "Use the blob_read operation get, head, or list.",
    },
    AGENT_R0210: {
      ...dynamicError,
      fix: "Pass blob_edit put only one of attachmentId, body, or workspacePath.",
    },
    AGENT_R0211: {
      ...dynamicError,
      fix: "Pass blob_edit put one of attachmentId, body, or workspacePath.",
    },
    AGENT_R0212: {
      ...dynamicError,
      fix: "Use the blob_edit operation put or delete.",
    },
    AGENT_R0213: {
      ...dynamicError,
      fix: "Set database in vitehub(), such as database: true, or run pnpm add @vite-hub/database in the app. The message shows the load error.",
    },
    AGENT_R0214: {
      ...dynamicError,
      fix: "Set database in vitehub(), such as database: true, so that the db() Capability gets a Database with exec().",
    },
    AGENT_R0215: {
      ...dynamicError,
      fix: "Set database in vitehub(), such as database: true, so that the db() Capability gets a Database with query().",
    },
    AGENT_R0216: {
      ...dynamicError,
      fix: "Set db({ database }) to a Database that the app defines, or remove it to use the default Database.",
    },
    AGENT_R0217: {
      ...dynamicError,
      fix: "Pass db_query one SELECT, WITH ... SELECT, or read-only PRAGMA statement. Use db_exec for changes.",
    },
    AGENT_R0218: {
      ...dynamicError,
      fix: "Pass db_exec a rationale that says why the statement must run.",
    },
    AGENT_R0219: {
      ...dynamicError,
      fix: "Pass db_exec one SQL statement per call.",
    },
    AGENT_R0220: {
      ...dynamicError,
      fix: "Run read-only SQL with db_query, not db_exec.",
    },
    AGENT_R0221: {
      ...dynamicError,
      fix: "Set db({ schemaMode: \"write\" }) to allow CREATE, ALTER, and DROP statements, or run the schema change in a migration.",
    },
    AGENT_R0222: {
      ...dynamicError,
      fix: "Set db({ mode: \"write\" }) to allow INSERT, UPDATE, and DELETE statements.",
    },
    AGENT_R0223: {
      ...dynamicError,
      fix: "Pass db_exec one INSERT, UPDATE, DELETE, or schema statement.",
    },
    AGENT_R0224: {
      ...dynamicError,
      fix: "Pass kv_read either key or prefix, not both and not neither.",
    },
    AGENT_R0225: {
      ...dynamicError,
      fix: "Use the kv_edit operation put or delete.",
    },
    // AGENT_R0226, AGENT_R0227, and AGENT_R0228 are retired. They duplicated AGENT_R0105, AGENT_R0106, and AGENT_R0104. Do not reuse them.
    AGENT_R0229: {
      ...dynamicError,
      fix: "Give the tool field that the message names a non-empty string.",
    },
    AGENT_R0230: {
      ...dynamicError,
      fix: "Use the ViteHub primitive that the message names, set in vitehub(), or a handle that has the method that the message names.",
    },
    AGENT_R0231: {
      ...dynamicError,
      fix: "Use the ViteHub primitive with named stores, set in vitehub(), or remove store from the Capability options.",
    },
    AGENT_R0232: {
      ...dynamicError,
      fix: "Add title() to defineAgent({ capabilities }) and let the Agent run it. Do not call its hooks yourself.",
    },
    AGENT_R0233: {
      ...dynamicError,
      fix: "Add title() to defineAgent({ capabilities }) and let the Agent run it. Do not call its hooks yourself.",
    },
    AGENT_R0234: {
      ...dynamicError,
      fix: "Upgrade the ai package in the app to a version that exports experimental_streamTranscribe.",
    },
    AGENT_R0235: {
      ...dynamicError,
      fix: "Set transcribe({ maxBytes }) to a positive number of bytes, or remove it to use the default.",
    },
    AGENT_R0236: {
      ...dynamicError,
      fix: "Send a smaller audio file, or raise transcribe({ maxBytes }).",
    },
    AGENT_R0237: {
      ...dynamicError,
      fix: "Give the audio part data, a fetchData() function, or a url.",
    },
    AGENT_R0238: {
      ...dynamicError,
      fix: "Check that the audio URL is public and returns the file, then retry. The message shows the HTTP status.",
    },
    AGENT_R0239: {
      ...dynamicError,
      fix: "Give the audio part data, a fetchData() function, or a url.",
    },
    AGENT_R0240: {
      ...dynamicError,
      fix: "Upgrade the ai package in the app to a version that exports transcribe or experimental_transcribe.",
    },
    AGENT_R0241: {
      ...dynamicError,
      fix: "Set the transcribe() option that the message names to a relative path inside the Workspace, not in .git or .vitehub and without \"..\".",
    },
    AGENT_R0242: {
      ...dynamicError,
      fix: "Give the Agent a Workspace with mode: \"write\" in defineAgent({ workspace }), or remove transcribe({ artifacts }).",
    },
    AGENT_R0243: {
      ...dynamicError,
      fix: "Give the Agent a Workspace with mode: \"write\" in defineAgent({ workspace }), or remove transcribe({ artifacts }).",
    },
    AGENT_R0244: {
      ...dynamicError,
      fix: "Pass elevenLabsScribe() an options object with apiKey and webhookId.",
    },
    AGENT_R0245: {
      ...dynamicError,
      fix: "Set elevenLabsScribe({ apiKey }) to the ElevenLabs API key or to a function that returns it.",
    },
    AGENT_R0246: {
      ...dynamicError,
      fix: "Set elevenLabsScribe({ webhookId }) to the ID of the webhook in your ElevenLabs account.",
    },
    // AGENT_R0247 through AGENT_R0255 are retired with openRouterTranscriptionModel(). Do not reuse them.
    AGENT_R0256: {
      ...dynamicError,
      fix: "Pass transcriptionError() one of the TRANSCRIPTION_ codes that ViteHub defines, such as \"TRANSCRIPTION_PROVIDER_FAILED\".",
    },
    AGENT_R0257: {
      ...dynamicError,
      fix: "Pass createTranscription({ driver }) a driver object with name, submit(), and receive().",
    },
    AGENT_R0258: {
      ...dynamicError,
      fix: "Give the transcription driver a name of at most 128 letters, digits, dots, /, - and _ that starts with a letter or digit, such as \"elevenlabs\".",
    },
    AGENT_R0259: {
      ...dynamicError,
      fix: "Give the transcription driver a submit() function.",
    },
    AGENT_R0260: {
      ...dynamicError,
      fix: "Give the transcription driver a receive() function.",
    },
    AGENT_R0261: {
      ...dynamicError,
      fix: "Pass the transcription metadata, or return the completion metadata from the driver, as a plain object.",
    },
    AGENT_R0262: {
      ...dynamicError,
      fix: "Pass the transcription source as an object, such as { url: \"https://example.com/audio.ogg\" }.",
    },
    AGENT_R0263: {
      ...dynamicError,
      fix: "Set source.url of the transcription to the URL of the audio file.",
    },
    AGENT_R0264: {
      ...dynamicError,
      fix: "Set source.url of the transcription to an http or https URL.",
    },
    AGENT_R0265: {
      ...dynamicError,
      fix: "Set source.mediaType of the transcription to a media type, such as \"audio/ogg\", or remove it.",
    },
    AGENT_R0266: {
      ...dynamicError,
      fix: "Set source.name of the transcription to a non-empty file name, or remove it.",
    },
    AGENT_R0267: {
      ...dynamicError,
      fix: "Make the transcription driver return a non-empty job id from the step that the message names.",
    },
    AGENT_R0268: {
      ...dynamicError,
      fix: "Read the message for the error of the transcription provider, and check the provider account and the audio file. Retry when the provider error is temporary.",
    },
    AGENT_R0269: {
      ...dynamicError,
      fix: "Pass webSearch({ mode: \"tool\", provider }) a provider name, or an object with a name.",
    },
    AGENT_R0270: {
      ...dynamicError,
      fix: "Pass webSearch() an options object with mode: \"tool\" or mode: \"model\".",
    },
    AGENT_R0271: {
      ...dynamicError,
      fix: "Set webSearch({ mode }) to \"tool\" or \"model\".",
    },
    AGENT_R0272: {
      ...dynamicError,
      fix: "Remove the options that the message names from the web search tool input.",
    },
    AGENT_R0273: {
      ...dynamicError,
      fix: "Pass the web search tool an object as input.",
    },
    AGENT_R0274: {
      ...dynamicError,
      fix: "Run pnpm add @agntn/web in the app, or use webSearch({ mode: \"model\" }).",
    },
    AGENT_R0275: {
      ...dynamicError,
      fix: "Pass web_search a non-empty query.",
    },
    AGENT_R0276: {
      ...dynamicError,
      fix: "Pass web_read a non-empty url.",
    },
    AGENT_R0277: {
      ...dynamicError,
      fix: "Pass the commands option that the message names at least one command.",
    },
    AGENT_R0278: {
      ...dynamicError,
      fix: "Use an executable name or an absolute path without spaces or control characters for each command that the message names.",
    },
    AGENT_R0279: {
      ...dynamicError,
      fix: "Give each entry of the commands option a string or an object with a command, such as { command: \"pnpm\" }.",
    },
    AGENT_R0280: {
      ...dynamicError,
      fix: "Set command of each commands entry to an executable name or an absolute path without spaces or control characters.",
    },
    AGENT_R0281: {
      ...dynamicError,
      fix: "Set description of the commands entry to a string, or remove it.",
    },
    AGENT_R0282: {
      ...dynamicError,
      fix: "Set install of the commands entry to a string, or remove it.",
    },
    AGENT_R0283: {
      ...dynamicError,
      fix: "Set the timeout that the message names to a positive number of milliseconds, at most 2147483647.",
    },
    AGENT_R0284: {
      ...dynamicError,
      fix: "Pass the workspace_exec field that the message names as an array of strings.",
    },
    AGENT_R0285: {
      ...dynamicError,
      fix: "Pass workspace_exec env as an object with string values.",
    },
    AGENT_R0286: {
      ...dynamicError,
      fix: "Use environment variable names without = or null bytes in workspace_exec env.",
    },
    AGENT_R0287: {
      ...dynamicError,
      fix: "Remove PATH and the LD_ and DYLD_ variables from workspace_exec env.",
    },
    AGENT_R0288: {
      ...dynamicError,
      fix: "Pass workspace_exec env as an object with string values.",
    },
    AGENT_R0289: {
      ...dynamicError,
      fix: "Pass workspace_exec cwd as a string, or omit it.",
    },
    AGENT_R0290: {
      ...dynamicError,
      fix: "Set workspace_exec cwd to a folder inside /workspace, without \"..\" or \".\" parts.",
    },
    AGENT_R0291: {
      ...dynamicError,
      fix: "Give the Agent a Workspace that can start a shell session in defineAgent({ workspace }).",
    },
    AGENT_R0292: {
      ...dynamicError,
      fix: "Read the stdout and stderr of the error to see why the Workspace command failed, then fix the command or its input.",
    },
    AGENT_R0293: {
      ...dynamicError,
      fix: "Run the Agent on a Workspace host that allows processes, such as a Sandbox, or remove the command tools.",
    },
    AGENT_R0294: {
      ...dynamicError,
      fix: "Read the stdout and stderr of the error to see why the Workspace command failed, then fix the command or its input.",
    },
    AGENT_R0295: {
      ...dynamicError,
      fix: "Pass the command tool a command string.",
    },
    AGENT_R0296: {
      ...dynamicError,
      fix: "Run a command from the commands option of the Capability, or add the command to that list.",
    },
    AGENT_R0297: {
      ...dynamicError,
      fix: "Set workspaceShell({ mode: \"write\" }) when you pass commands, or remove commands.",
    },
    AGENT_R0298: {
      ...dynamicError,
      fix: "Use a Provider Agent Driver with workspaceShell({ commands }), or use sandbox() for command tools of model-backed Agents.",
    },
    AGENT_R0299: {
      ...dynamicError,
      fix: "Give the Capability CLI a name that starts with a letter and has only letters, digits, - and _.",
    },
    AGENT_R0300: {
      ...dynamicError,
      fix: "Give the CLI command a name of letters, digits, dots, - and _, without spaces.",
    },
    AGENT_R0301: {
      ...dynamicError,
      fix: "Give the CLI part that the message names at least one command in commands.",
    },
    AGENT_R0302: {
      ...dynamicError,
      fix: "Make the CLI command that the message names an object with commands or run.",
    },
    AGENT_R0303: {
      ...dynamicError,
      fix: "Give the CLI command that the message names either commands or run, not both.",
    },
    AGENT_R0304: {
      ...dynamicError,
      fix: "Set description of the CLI command to a string, or remove it.",
    },
    AGENT_R0305: {
      ...dynamicError,
      fix: "Set effects of the CLI command to an array of non-empty strings, or remove it.",
    },
    AGENT_R0306: {
      ...dynamicError,
      fix: "Set examples of the CLI command to an array of non-empty strings, or remove it.",
    },
    AGENT_R0307: {
      ...dynamicError,
      fix: "Set input of the CLI command to a Standard Schema, such as a Valibot or Zod schema, or remove it.",
    },
    AGENT_R0308: {
      ...dynamicError,
      fix: "Set output of the CLI command to a Standard Schema or to { schema, format }, or remove it.",
    },
    AGENT_R0309: {
      ...dynamicError,
      fix: "Set output.format of the CLI command to \"json\" or \"text\".",
    },
    AGENT_R0310: {
      ...dynamicError,
      fix: "Set run of the CLI command to a function.",
    },
    AGENT_R0311: {
      ...dynamicError,
      fix: "Set cli of the Capability that the message names to an object with name and commands.",
    },
    AGENT_R0312: {
      ...dynamicError,
      fix: "Set cli.description of the Capability to a string, or remove it.",
    },
    AGENT_R0313: {
      ...dynamicError,
      fix: "Pass --input a valid JSON value, such as --input '{\"id\":1}'.",
    },
    AGENT_R0314: {
      ...dynamicError,
      fix: "Pass a JSON value after --input, such as --input '{\"id\":1}'.",
    },
    AGENT_R0315: {
      ...dynamicError,
      fix: "Pass the Capability CLI command only --input and --json, or run the command with --help to see its options.",
    },
    AGENT_R0316: {
      ...dynamicError,
      fix: "Use a command that the Capability CLI defines. Run the CLI name with --help to list its commands.",
    },
    AGENT_R0317: {
      ...dynamicError,
      fix: "Add a subcommand after the Capability CLI command, or run the --help command that the message shows to list the subcommands.",
    },
    AGENT_R0318: {
      ...dynamicError,
      fix: "Pass sandbox({ commands }) a non-empty array of executable names, such as [\"node\", \"pnpm\"], or remove commands.",
    },
    AGENT_R0319: {
      ...dynamicError,
      fix: "Pass sandbox({ commands }) executable names only, such as \"pnpm\", without arguments, paths, or shell syntax.",
    },
    // AGENT_R0320 and AGENT_R0405 are retired. Nothing raised AGENT_R0320, and AGENT_R0405 only read a call stack. Do not reuse them.
    AGENT_R0321: {
      ...dynamicError,
      fix: "Give the Agent a Workspace in defineAgent({ workspace }), or remove the Capability that the message names.",
    },
    AGENT_R0322: {
      ...dynamicError,
      fix: "Set defineAgent({ workspace: { mode: \"write\" } }), or remove mode: \"write\" from workspaceShell().",
    },
    AGENT_R0323: {
      ...dynamicError,
      fix: "Give each Workspace Source that your Capabilities contribute a different key, or remove one of the Capabilities that the message names.",
    },
    AGENT_R0324: {
      ...dynamicError,
      fix: "Put access() first in defineAgent({ capabilities }).",
    },
    AGENT_R0325: {
      ...dynamicError,
      fix: "Rename the source that the Capability workspace() hook returns, or remove the Workspace Source with the same key from the Workspace Definition.",
    },
    AGENT_R0326: {
      ...dynamicError,
      fix: "Give the two contributed Workspace Sources different mount paths, or remove one of the Capabilities that contribute them.",
    },
    AGENT_R0327: {
      ...dynamicError,
      fix: "Give the contributed Workspace Source a mount path that no other Workspace Source uses, or remove the Workspace Source that the message names from the Workspace Definition.",
    },
    AGENT_R0328: {
      ...dynamicError,
      fix: "Change the rule that the Capability workspace() hook returns so that it does not overlap the Workspace Rule that the message names, or remove one of the rules.",
    },
    AGENT_R0329: {
      ...dynamicError,
      fix: "Add the source to the Workspace Scope that access({ workspace }) selects, or mount it inside the paths of that scope.",
    },
    AGENT_R0330: {
      ...dynamicError,
      fix: "Give the contributed Workspace Source a mount path that no other Workspace Source uses, or remove one of the sources that the message names.",
    },
    AGENT_R0331: {
      ...dynamicError,
      fix: "Mount the contributed Workspace Source at a path that does not exist in the Workspace, or move or delete the files at that path.",
    },
    AGENT_R0332: {
      ...dynamicError,
      fix: "Remove the source key that the message names from the access({ workspace }) scope, or add a Workspace Source with that key to the Workspace Definition.",
    },
    AGENT_R0333: {
      ...dynamicError,
      fix: "Add the source to the Workspace Scope that access({ workspace }) selects, or mount it inside the paths of that scope.",
    },
    AGENT_R0334: {
      ...dynamicError,
      fix: "Pass context.delivery.effect() an object with a non-empty kind string, such as { kind: \"reply\", payload }.",
    },
    AGENT_R0335: {
      ...dynamicError,
      fix: "Pass context.delivery.finishEffect() a function, an effect object with a non-empty kind string, or an array of such objects.",
    },
    AGENT_R0336: {
      ...dynamicError,
      fix: "Set driver.model in defineAgent(), or pass a model to context.model.resolve() in the Capability that the message names.",
    },
    AGENT_R0337: {
      ...dynamicError,
      fix: "Pass context.telemetry.metadata() a plain object, such as { installation: \"acme\" }.",
    },
    AGENT_R0338: {
      ...dynamicError,
      fix: "Rename the Capability CLI that the message names, or remove or rename the Agent tool with the same name.",
    },
    AGENT_R0339: {
      ...dynamicError,
      fix: "Rename the Capability tool that the message names so that it does not use the name of a Capability CLI.",
    },
    AGENT_R0340: {
      ...dynamicError,
      fix: "Give the Agent a Workspace in defineAgent({ workspace }), or remove the Capability that the message names.",
    },
    AGENT_R0341: {
      ...dynamicError,
      fix: "Set defineAgent({ workspace: { mode: \"write\" } }), or remove the Capability that the message names.",
    },
    AGENT_R0342: {
      ...dynamicError,
      fix: "Add the path that the message names to the Workspace, or remove it from requires.workspace.paths of the Capability.",
    },
    AGENT_R0343: {
      ...dynamicError,
      fix: "Call pullRequest.read() only in an Invocation that a GitHub pull request Channel started, such as github({ pullRequest: true }).",
    },
    AGENT_R0344: {
      ...dynamicError,
      fix: "Set github({ pullRequest: { workspace: { mount } } }) to a relative path inside the Workspace, without \"..\", .git, or .vitehub.",
    },
    AGENT_R0345: {
      ...dynamicError,
      fix: "Set github({ app: { appId } }) or VITEHUB_GITHUB_APP_ID, or make github({ app: { token } }) return a non-empty token, as the message names.",
    },
    AGENT_R0346: {
      ...dynamicError,
      fix: "Set github({ app: { installationId } }) to a number, or remove it so that ViteHub finds the installation of the repository.",
    },
    AGENT_R0347: {
      ...dynamicError,
      fix: "Make github({ app: { privateKeyPath } }) or VITEHUB_GITHUB_PRIVATE_KEY_PATH point to a readable PEM file. Read error.cause for the file error.",
    },
    AGENT_R0348: {
      ...dynamicError,
      fix: "Set github({ app: { privateKey } }), github({ app: { privateKeyPath } }), VITEHUB_GITHUB_PRIVATE_KEY, or VITEHUB_GITHUB_PRIVATE_KEY_PATH.",
    },
    AGENT_R0349: {
      ...dynamicError,
      fix: "Check that github({ app: { apiBaseUrl } }) points to the GitHub REST API and that the App is installed on the repository. Read error.cause for the response.",
    },
    AGENT_R0350: {
      ...dynamicError,
      fix: "Check that the GitHub App or token can write issues and pull requests in the repository. Read error.cause for the GitHub error. A retry helps only for 429 or 5xx.",
    },
    AGENT_R0351: {
      ...dynamicError,
      fix: "Check that the GitHub App or token can read the repository and its pull requests. Read error.cause for the GitHub error. A retry helps only for 429 or 5xx.",
    },
    AGENT_R0352: {
      ...dynamicError,
      fix: "Check that the Forge token can read pull request comments and files in the repository. Read error.cause for the Forge error. A retry helps only for 429 or 5xx.",
    },
    AGENT_R0353: {
      ...dynamicError,
      fix: "Check that the Forge token can read pull request comments in the repository. Read error.cause for the Forge error. A retry helps only for 429 or 5xx.",
    },
    AGENT_R0354: {
      ...dynamicError,
      fix: "Check that the Forge token can read pull request comments in the repository. Read error.cause for the Forge error. A retry helps only for 429 or 5xx.",
    },
    AGENT_R0355: {
      ...dynamicError,
      fix: "Check that github({ app: { apiBaseUrl } }) points to the GitHub REST API and that the App ID and private key are correct. Read error.cause for the response.",
    },
    AGENT_R0356: {
      ...dynamicError,
      fix: "Set github({ app }) or VITEHUB_GITHUB_TOKEN with a token that can read its own user, or set github({ app: { identity } }).",
    },
    AGENT_R0357: {
      ...dynamicError,
      fix: "Set run.activity.target to { repository: \"owner/name\", issue: <number> } when you start the Invocation.",
    },
    AGENT_R0358: {
      ...dynamicError,
      fix: "Set run.activity.target.repository to \"owner/name\" and run.activity.target.issue to a positive integer.",
    },
    AGENT_R0359: {
      ...dynamicError,
      fix: "Set github({ app }), the VITEHUB_GITHUB_APP_ID and VITEHUB_GITHUB_PRIVATE_KEY env variables, or VITEHUB_GITHUB_TOKEN.",
    },
    AGENT_R0360: {
      ...dynamicError,
      fix: "Check that the GitHub App or token can read the repository. Read error.cause for the GitHub error. A retry helps only for 429 or 5xx.",
    },
    AGENT_R0361: {
      ...dynamicError,
      fix: "Check that the GitHub App or token can read Git references in the repository. Read error.cause for the GitHub error. A retry helps only for 429 or 5xx.",
    },
    AGENT_R0362: {
      ...dynamicError,
      fix: "Publish delivery artifacts only for an open pull request whose base branch exists, or remove the artifacts from the delivery.",
    },
    AGENT_R0363: {
      ...dynamicError,
      fix: "Check that the GitHub App or token can write contents in the repository, so it can create the artifact branch. Read error.cause for the GitHub error.",
    },
    AGENT_R0364: {
      ...dynamicError,
      fix: "Call message.reply() instead of message.update() in the inputCommands() hook when a pull request event starts the Invocation, because no triggering comment exists.",
    },
    AGENT_R0365: {
      ...dynamicError,
      fix: "Run pnpm add with the package that the message names. For @vite-hub/kv, also set kv in vitehub().",
    },
    AGENT_R0366: {
      ...dynamicError,
      fix: "Check that the Discord bot token can manage threads in the channel. The message shows the Discord status and error. A retry helps only for 429 or 5xx.",
    },
    AGENT_R0367: {
      ...dynamicError,
      fix: "Check that the GitHub App or token can write issue comments in the repository. Read error.cause for the GitHub error.",
    },
    AGENT_R0368: {
      ...dynamicError,
      fix: "Start the Invocation from the GitHub pull request Channel, which sets the pull request repository, or redeliver the GitHub webhook.",
    },
    AGENT_R0369: {
      ...dynamicError,
      fix: "Start the Invocation from the GitHub pull request Channel, which sets the pull request ref, or redeliver the GitHub webhook.",
    },
    AGENT_R0370: {
      ...dynamicError,
      fix: "Check that the GitHub App or token can read the pull request and that the host can reach GitHub, then redeliver the webhook. Read error.cause for the GitHub error, or set github({ pullRequest: { workspace: false } }).",
    },
    AGENT_R0371: {
      ...dynamicError,
      fix: "Pass channelAdapter() a non-empty Channel kind string, such as \"slack\".",
    },
    AGENT_R0372: {
      ...dynamicError,
      fix: "Remove path from http(), and set the route with http({ webhooks: { path } }).",
    },
    AGENT_R0373: {
      ...dynamicError,
      fix: "Pass telegram() either webhookSecret or webhooks, not both.",
    },
    AGENT_R0374: {
      ...dynamicError,
      fix: "Pass telegram({ botToken }), or set VITEHUB_TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN.",
    },
    AGENT_R0375: {
      ...dynamicError,
      fix: "Send the chat.message trigger at least one UI message in messages.",
    },
    AGENT_R0376: {
      ...dynamicError,
      fix: "Make messages.errorFallbackText return before messages.timeout, or set it to a string.",
    },
    AGENT_R0377: {
      ...dynamicError,
      fix: "Call thread.post() in messages.errorFallbackText only before the function returns, and await it.",
    },
    AGENT_R0378: {
      ...dynamicError,
      fix: "Remove messages.stream and messages.commentary when you set messages.loading or messages.delivery: \"manual\".",
    },
    AGENT_R0379: {
      ...dynamicError,
      fix: "Set messages.loading.updates to \"commentary\", or remove it.",
    },
    AGENT_R0380: {
      ...dynamicError,
      fix: "Set messages.loading.intervalMs to a positive number of milliseconds, such as 2000.",
    },
    AGENT_R0381: {
      ...dynamicError,
      fix: "Set messages.final.delivery to \"new-message\" or \"placeholder\".",
    },
    AGENT_R0382: {
      ...dynamicError,
      fix: "Set messages.timeout to a positive number of milliseconds, such as 60000.",
    },
    AGENT_R0383: {
      ...dynamicError,
      fix: "Set messages.loading or messages.delivery: \"manual\" when you set messages.durable, or remove messages.durable.",
    },
    AGENT_R0384: {
      ...dynamicError,
      fix: "Set messages.concurrency to \"parallel\" or \"steer\" when you set messages.durable, or remove messages.durable.",
    },
    AGENT_R0385: {
      ...dynamicError,
      fix: "Put a value after the option that the message names, such as --timeout 90000.",
    },
    AGENT_R0386: {
      ...dynamicError,
      fix: "Pass a number after --threshold, such as vitehub agent eval --threshold 0.8.",
    },
    AGENT_R0387: {
      ...dynamicError,
      fix: "Pass a number to --threshold, such as vitehub agent eval --threshold=0.8.",
    },
    AGENT_R0388: {
      ...dynamicError,
      fix: "Remove the unknown option. Run vitehub agent eval --help to list the options.",
    },
    AGENT_R0389: {
      ...dynamicError,
      fix: "Pass vitehub agent eval at most one path argument.",
    },
    AGENT_R0390: {
      ...dynamicError,
      fix: "Put the prompt text after -p or --prompt, such as vitehub agent dev -p \"hello\".",
    },
    AGENT_R0391: {
      ...dynamicError,
      fix: "Put the prompt text after --prompt=, such as vitehub agent dev --prompt=\"hello\".",
    },
    AGENT_R0392: {
      ...dynamicError,
      fix: "Pass --cli <name> before --, such as vitehub agent dev --cli inventory -- items list.",
    },
    AGENT_R0393: {
      ...dynamicError,
      fix: "Pass a positive number of milliseconds after --timeout, such as --timeout 90000.",
    },
    AGENT_R0394: {
      ...dynamicError,
      fix: "Pass a positive number of milliseconds to --timeout, such as --timeout=90000.",
    },
    AGENT_R0395: {
      ...dynamicError,
      fix: "Remove the unknown option. Run vitehub agent dev --help to list the options.",
    },
    AGENT_R0396: {
      ...dynamicError,
      fix: "Pass the message as text or with --prompt, not both.",
    },
    AGENT_R0397: {
      ...dynamicError,
      fix: "Remove the message text, --prompt, and --trigger when you pass --cli, or remove --cli.",
    },
    AGENT_R0398: {
      ...dynamicError,
      fix: "Pass --input a JSON object, such as --input '{\"text\":\"hello\"}', or @file with a JSON object.",
    },
    AGENT_R0399: {
      ...dynamicError,
      fix: "Use a relative artifact path inside the Workspace, without a leading / or \"..\".",
    },
    AGENT_R0400: {
      ...dynamicError,
      fix: "Give the Agent a Workspace in defineAgent({ workspace }) before you call publishWorkspaceArtifacts().",
    },
    AGENT_R0401: {
      ...dynamicError,
      fix: "Rename the Agent file or the Agent so that its name has 512 characters or fewer.",
    },
    AGENT_R0402: {
      ...dynamicError,
      fix: "Set the model of the Agent Evaluation variant to a model id string, such as \"gpt-5.1\", for Codex and Claude Code Drivers.",
    },
    AGENT_R0403: {
      ...dynamicError,
      fix: "Give the Agent a model-backed Driver, such as driver: { model }, or remove model and instructions from the Agent Evaluation variant.",
    },
    AGENT_R0404: {
      ...dynamicError,
      fix: "Give the Agent a model-backed Driver, such as driver: { model }, or remove model and instructions from the Agent Evaluation variant.",
    },
    AGENT_R0406: {
      ...dynamicError,
      fix: "Pass the Agent Definition to defineEval() explicitly, or put the eval file next to the Agent file as <name>.eval.ts.",
    },
    AGENT_R0407: {
      ...dynamicError,
      fix: "Default export the Agent Definition from the file that the message names, such as export default defineAgent({ ... }).",
    },
    AGENT_R0408: {
      ...dynamicError,
      fix: "Create the Agent with defineAgent(), or remove model and instructions from the Agent Evaluation variant.",
    },
    AGENT_R0409: {
      ...dynamicError,
      fix: "Pass defineEval({ scenarios }) at least one scenario.",
    },
    AGENT_R0410: {
      ...dynamicError,
      fix: "Pass defineEval() scenarios or test.",
    },
    AGENT_R0411: {
      ...dynamicError,
      fix: "Call t.send() in the test() function of the Agent Eval.",
    },
    AGENT_R0412: {
      ...dynamicError,
      fix: "Make vitehub agent eval find at least one eval file and finish a full run, or remove --output.",
    },
    // AGENT_R0413 through AGENT_R0420 are retired with the Eve extension adapter. Do not reuse them.
    AGENT_R0421: {
      ...dynamicError,
      fix: "Pass a name to agentWorkflow(), such as agentWorkflow(\"support\"), when you call it outside a discovered Agent.",
    },
    AGENT_R0422: {
      ...dynamicError,
      fix: "Give this Agent its own Workflow name with agentWorkflow(\"other-name\"), or run the discovered Agent that owns the name.",
    },
    AGENT_R0423: {
      ...dynamicError,
      fix: "Check the Channel credentials and permissions for activity, such as the GitHub App permissions for issue comments. Read error.cause for the Channel error.",
    },
    AGENT_R0424: {
      ...dynamicError,
      fix: "Make the waitUntil() function of the runtime context accept a Promise, or remove activity from the Channel.",
    },
    AGENT_R0425: {
      ...dynamicError,
      fix: "Pass each Channel in defineAgent({ channels }) as a Channel definition, such as webChat(), or as the name of a file in server/channels, as the message shows.",
    },
    AGENT_R0426: {
      ...dynamicError,
      fix: "Move the chat() options to defineAgent({ messages, channels }), and remove chat() from capabilities.",
    },
    AGENT_R0427: {
      ...dynamicError,
      fix: "Set driver in defineAgent(), such as driver: { model } or driver: { run }.",
    },
    AGENT_R0428: {
      ...dynamicError,
      fix: "Read the stream of the Invocation output before the Invocation finishes.",
    },
    AGENT_R0429: {
      ...dynamicError,
      fix: "Call toUIMessageStream() on the Invocation output before the Invocation finishes.",
    },
    AGENT_R0430: {
      ...dynamicError,
      fix: "Set defineAgent({ name }) to 512 characters or fewer.",
    },
    AGENT_R0431: {
      ...dynamicError,
      fix: "Rename the Workspace source that the message names in the Agent workspace options, because the registered Workspace already defines that key.",
    },
    // AGENT_R0432, AGENT_R0433, AGENT_R0436, AGENT_R0437, AGENT_R0445, AGENT_R0448, AGENT_R0449, and AGENT_R0515 are retired. Nothing raised AGENT_R0445, AGENT_R0448, or AGENT_R0449, and only a ViteHub bug reached the others. Do not reuse them.
    AGENT_R0434: {
      ...dynamicError,
      fix: "Make the finish delivery effect resolver of the Channel return an object with a non-empty kind string.",
    },
    AGENT_R0435: {
      ...dynamicError,
      fix: "Make the chat error fallback reply finish before messages.timeout, for example with a faster messages.errorFallbackText function. A retry does not help.",
    },
    AGENT_R0438: {
      ...dynamicError,
      fix: "Read the message for the error that the model stream reported, and check the model ID and the provider API key. A retry helps for rate limits and 5xx errors.",
    },
    AGENT_R0439: {
      ...dynamicError,
      fix: "Call toUIMessageStream() on the Invocation output before the Invocation finishes.",
    },
    AGENT_R0440: {
      ...dynamicError,
      fix: "Call toUIMessageStream() only once for each Invocation output.",
    },
    AGENT_R0441: {
      ...dynamicError,
      fix: "Read the stream of the Invocation output before the Invocation finishes.",
    },
    AGENT_R0442: {
      ...dynamicError,
      fix: "Call toUIMessageStream() on the Invocation output before the Invocation finishes.",
    },
    AGENT_R0443: {
      ...dynamicError,
      fix: "Read textStream of the Invocation output before the Invocation finishes.",
    },
    AGENT_R0444: {
      ...dynamicError,
      fix: "Set a Workflow provider and remove nonportable Capabilities from the Agent, or set messages.durable: false on the Channel.",
    },
    AGENT_R0446: {
      ...dynamicError,
      fix: "Make the instruction expression that the message names resolve to a scalar, such as {{ context.customer.name }}. Read error.cause for the template error.",
    },
    AGENT_R0447: {
      ...dynamicError,
      fix: "Change the instruction template or condition that the message names. Read error.cause for the template error.",
    },
    AGENT_R0450: {
      ...dynamicError,
      fix: "Give each instruction skill block a non-empty path, and each other instruction block a non-empty key.",
    },
    AGENT_R0451: {
      ...dynamicError,
      fix: "Do not abort the Invocation, or pass a reason to AbortController.abort(reason) to see why it stopped.",
    },
    AGENT_R0452: {
      ...dynamicError,
      fix: "Retry later, or raise driver.capacity.concurrency, driver.capacity.queue.maxPending, or driver.capacity.queue.timeout. For a sample timeout, make driver.capacity.adaptive.sample() answer before sampleTimeoutMs.",
    },
    AGENT_R0453: {
      ...dynamicError,
      fix: "Make driver.capacity.adaptive.sample() return an object with a finite concurrency number, such as { concurrency: 4 }.",
    },
    AGENT_R0454: {
      ...dynamicError,
      fix: "Remove the driver option that the message names, or correct its spelling.",
    },
    AGENT_R0455: {
      ...dynamicError,
      fix: "Set driver.capacity to an object, such as { concurrency: 4 }.",
    },
    AGENT_R0456: {
      ...dynamicError,
      fix: "Set driver.capacity.concurrency to a positive integer, such as 4.",
    },
    AGENT_R0457: {
      ...dynamicError,
      fix: "Set driver.capacity.queue to an object, such as { maxPending: 20 }.",
    },
    AGENT_R0458: {
      ...dynamicError,
      fix: "Set driver.capacity.queue.maxPending to a positive integer, such as 20.",
    },
    AGENT_R0459: {
      ...dynamicError,
      fix: "Set driver.capacity.queue.timeout to a positive number of milliseconds no greater than 2147483647, or remove it.",
    },
    AGENT_R0460: {
      ...dynamicError,
      fix: "Set driver.capacity.adaptive to an object with a sample function.",
    },
    AGENT_R0461: {
      ...dynamicError,
      fix: "Set driver.capacity.adaptive.sample to a function that returns { concurrency }.",
    },
    AGENT_R0462: {
      ...dynamicError,
      fix: "Set driver.capacity.adaptive.fallbackConcurrency to an integer from 0 to driver.capacity.concurrency, or remove it.",
    },
    AGENT_R0463: {
      ...dynamicError,
      fix: "Set driver.capacity.adaptive.intervalMs to a number of milliseconds from 100 to 2147483647, or remove it.",
    },
    AGENT_R0464: {
      ...dynamicError,
      fix: "Set driver.capacity.adaptive.rampUp to a positive integer, or remove it.",
    },
    AGENT_R0465: {
      ...dynamicError,
      fix: "Set driver.capacity.adaptive.sampleTimeoutMs to a positive number of milliseconds no greater than 2147483647, or remove it.",
    },
    AGENT_R0466: {
      ...dynamicError,
      fix: "Set driver.env to an object of string or undefined values, or to a resolver function.",
    },
    AGENT_R0467: {
      ...dynamicError,
      fix: "Set each value of driver.env to a string or undefined.",
    },
    AGENT_R0468: {
      ...dynamicError,
      fix: "Set driver.launch to a resolver function or an object with a non-empty command string, and set driver.launch.onExit to a function or remove it.",
    },
    AGENT_R0469: {
      ...dynamicError,
      fix: "Set driver.launch.args to an array of strings.",
    },
    AGENT_R0470: {
      ...dynamicError,
      fix: "Set driver.permissions to \"ask\", \"allow-edits\", \"allow-edits-unattended\", or \"allow-all\".",
    },
    AGENT_R0471: {
      ...dynamicError,
      fix: "Set driver.execution to an object, or remove it.",
    },
    AGENT_R0472: {
      ...dynamicError,
      fix: "Set driver.execution.attachments to an object, such as { maxBytes: 10000000 }, or remove it.",
    },
    AGENT_R0473: {
      ...dynamicError,
      fix: "Set driver.execution.attachments.maxBytes to a positive number of bytes.",
    },
    AGENT_R0474: {
      ...dynamicError,
      fix: "Set driver.model to a non-empty model ID string, or remove it.",
    },
    AGENT_R0475: {
      ...dynamicError,
      fix: "Set driver.providerSettings to an object, or remove it.",
    },
    AGENT_R0476: {
      ...dynamicError,
      fix: "Set driver.sessionStorePath to a non-empty file path, or remove it.",
    },
    AGENT_R0477: {
      ...dynamicError,
      fix: "Remove the Codex options that the message names from claudeCodeDriver(), or use codexDriver().",
    },
    AGENT_R0478: {
      ...dynamicError,
      fix: "Set driver.credentials to a string, a sealed Server Env value, or a resolver function.",
    },
    AGENT_R0479: {
      ...dynamicError,
      fix: "Set driver.credentialProfile to a non-empty name, such as \"work\".",
    },
    AGENT_R0480: {
      ...dynamicError,
      fix: "Set driver.credentialProfile to at most 128 characters that start with a lowercase letter or number and have only lowercase letters, numbers, dots, underscores, or hyphens.",
    },
    AGENT_R0481: {
      ...dynamicError,
      fix: "Rename driver.credentialProfile so that it does not end with a dot and is not a reserved Windows name, such as con, nul, or com1.",
    },
    AGENT_R0482: {
      ...dynamicError,
      fix: "Set driver.credentials when you set driver.credentialProfile, or remove driver.credentialProfile.",
    },
    AGENT_R0483: {
      ...dynamicError,
      fix: "Set driver.credentialProfile when you set driver.credentials and driver.sessionStorePath, or remove driver.sessionStorePath.",
    },
    AGENT_R0484: {
      ...dynamicError,
      fix: "Set driver.reasoningEffort to a value that the model lists, such as \"medium\", or remove it.",
    },
    AGENT_R0485: {
      ...dynamicError,
      fix: "Set driver.reasoningSummary to \"auto\", \"concise\", \"detailed\", or \"none\".",
    },
    AGENT_R0486: {
      ...dynamicError,
      fix: "Set driver.model when you set driver.reasoningEffort or driver.reasoningSummary.",
    },
    AGENT_R0487: {
      ...dynamicError,
      fix: "Remove providerSettings.shadowHomePath when you set driver.credentials.",
    },
    AGENT_R0488: {
      ...dynamicError,
      fix: "Remove driver.env.CODEX_HOME when you set driver.credentials.",
    },
    AGENT_R0489: {
      ...dynamicError,
      fix: "Remove driver.env.T3CODE_CODEX_LAUNCH_ARGS, or remove driver.reasoningEffort and driver.reasoningSummary.",
    },
    AGENT_R0490: {
      ...dynamicError,
      fix: "Set driver to codexDriver(), claudeCodeDriver(), or a custom { model }, { run }, or { ask } driver object, not a string.",
    },
    AGENT_R0491: {
      ...dynamicError,
      fix: "Set driver to codexDriver(), claudeCodeDriver(), or a custom { model }, { run }, or { ask } driver object.",
    },
    AGENT_R0492: {
      ...dynamicError,
      fix: "Create the provider Driver with codexDriver() or claudeCodeDriver() from vite-hub/agent, and do not set driver.kind yourself.",
    },
    AGENT_R0493: {
      ...dynamicError,
      fix: "Set exactly one of driver.model, driver.run, or driver.ask.",
    },
    AGENT_R0494: {
      ...dynamicError,
      fix: "Set driver.maxRetries to a non-negative integer, such as 2.",
    },
    AGENT_R0495: {
      ...dynamicError,
      fix: "Change the driver option that the message names: give title() and progressSummary() a Driver with model or run, set driver.ask to Jev questions or a function that returns them, or set maxRetries in one place only.",
    },
    AGENT_R0496: {
      ...dynamicError,
      fix: "Set driver.run to a function.",
    },
    AGENT_R0497: {
      ...dynamicError,
      fix: "Set driver in defineAgent() to codexDriver(), claudeCodeDriver(), or a custom { model }, { run }, or { ask } driver.",
    },
    AGENT_R0498: {
      ...dynamicError,
      fix: "Put a value after the option that the message names, such as vitehub agent get --agent support.",
    },
    AGENT_R0499: {
      ...dynamicError,
      fix: "Remove the unknown option. Run vitehub agent get --help to list the options.",
    },
    AGENT_R0500: {
      ...dynamicError,
      fix: "Remove the extra argument. Pass the Agent with vitehub agent get --agent <name>.",
    },
    AGENT_R0501: {
      ...dynamicError,
      fix: "Pass --url the URL of the running Vite Development Server of the app, and use the same vite-hub version in the CLI and the app.",
    },
    AGENT_R0502: {
      ...dynamicError,
      fix: "Put a value after the option that the message names. For undo, pass --change <id> from vitehub agent invocations get <id>.",
    },
    AGENT_R0503: {
      ...dynamicError,
      fix: "Change the option value that the message names to the form that it shows, such as --since 7d, --timeout 30s, or an HTTPS --url without credentials.",
    },
    AGENT_R0504: {
      ...dynamicError,
      fix: "Remove the unknown option. Run vitehub agent invocations --help to list the options.",
    },
    AGENT_R0505: {
      ...dynamicError,
      fix: "Remove the option or argument that the message names, or use it with an action that supports it. Run vitehub agent invocations --help to see the options of each action.",
    },
    AGENT_R0506: {
      ...dynamicError,
      fix: "Pass an action, such as vitehub agent invocations list.",
    },
    AGENT_R0507: {
      ...dynamicError,
      fix: "Pass the invocation ID after the action, such as vitehub agent invocations get <id>. Run vitehub agent invocations list to find it.",
    },
    AGENT_R0508: {
      ...dynamicError,
      fix: "Pass --url the app that enables the Console, and use the same vite-hub version in the CLI and the app.",
    },
    AGENT_R0509: {
      ...dynamicError,
      fix: "Pass --url the app that enables the Console, and use the same vite-hub version in the CLI and the app.",
    },
    AGENT_R0510: {
      ...dynamicError,
      fix: "Pass --url the app that enables the Console, and use the same vite-hub version in the CLI and the app.",
    },
    AGENT_R0511: {
      ...dynamicError,
      fix: "Check --url and the Console key in VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>. The message shows the HTTP status. A retry helps only for network errors and 5xx.",
    },
    AGENT_R0512: {
      ...dynamicError,
      fix: "Set driver.model.apiKey to a string or a sealed Server Env value.",
    },
    AGENT_R0513: {
      ...dynamicError,
      fix: "Set driver.model.apiKey to a non-empty value, or remove it.",
    },
    AGENT_R0514: {
      ...dynamicError,
      fix: "Set driver.model to a non-empty model ID, such as \"gpt-5.5\". For chatgpt(), list the IDs with vitehub connections models chatgpt.",
    },
    AGENT_R0516: {
      ...dynamicError,
      fix: "Use a Standard Schema library, such as Valibot or Zod, whose validate() returns { value } or { issues } with an issues array.",
    },
    AGENT_R0517: {
      ...dynamicError,
      fix: "Change the Agent output schema or the instructions so that the model output matches the schema. The message lists the issues.",
    },
    AGENT_R0518: {
      ...dynamicError,
      fix: "Use a Standard Schema library, such as Valibot or Zod, whose validate() returns { value } or { issues }.",
    },
    AGENT_R0519: {
      ...dynamicError,
      fix: "Retry the delivery. If it fails again, check that the Agent State store is reachable and that no other process holds the delivery for a long time.",
    },
    AGENT_R0520: {
      ...dynamicError,
      fix: "Retry the delivery. If it fails again, check that the Agent State store is reachable and answers in less than 30 seconds.",
    },
    AGENT_R0521: {
      ...dynamicError,
      fix: "Put a value after the option that the message names, such as --query key=value or an absolute --webhook-path /api/webhooks/telegram.",
    },
    AGENT_R0522: {
      ...dynamicError,
      fix: "Remove the unknown option. Run vitehub channels history --help to list the options.",
    },
    AGENT_R0523: {
      ...dynamicError,
      fix: "Pass --url an HTTPS origin only, such as --url https://app.example.com, without credentials, a path, a query, or a fragment.",
    },
    AGENT_R0524: {
      ...dynamicError,
      fix: "Set a webhook secret on the Channel webhook registration, such as secretToken, and make a base64 secret canonical base64.",
    },
    AGENT_R0525: {
      ...dynamicError,
      fix: "Check that the --url origin is reachable and serves the deployed app, then run the command again.",
    },
    AGENT_R0526: {
      ...dynamicError,
      fix: "Pass --url the origin of the deployment that serves this Channel, and deploy the app version that has the Channel.",
    },
    AGENT_R0527: {
      ...dynamicError,
      fix: "Pass --stage <name>, such as vitehub channels history --stage production.",
    },
    AGENT_R0528: {
      ...dynamicError,
      fix: "Pass --url <https-origin>, or set vitehub({ publicUrl }).",
    },
    AGENT_R0529: {
      ...dynamicError,
      fix: "Pass --output <directory> for the exported history files.",
    },
    AGENT_R0530: {
      ...dynamicError,
      fix: "Select one Channel with --agent <name> and --channel <id>.",
    },
    AGENT_R0531: {
      ...dynamicError,
      fix: "Pass --thread <id> for a Channel whose provider cannot list its threads.",
    },
    AGENT_R0532: {
      ...dynamicError,
      fix: "Give the Channel a webhook registration with a path or url, or pass --webhook-path <path>.",
    },
    AGENT_R0533: {
      ...dynamicError,
      fix: "Pass --output a directory that does not exist yet, or move the existing directory.",
    },
    AGENT_R0534: {
      ...dynamicError,
      fix: "Check that the deployed app runs the same vite-hub version as the CLI, then run the export again. The message shows the HTTP status.",
    },
    AGENT_R0535: {
      ...dynamicError,
      fix: "Put a value after the option that the message names, such as --stage production.",
    },
    AGENT_R0536: {
      ...dynamicError,
      fix: "Remove the unknown option. Run vitehub channels sync --help to list the options.",
    },
    AGENT_R0537: {
      ...dynamicError,
      fix: "Set the URL that the message names to a valid HTTPS URL, such as https://app.example.com/api/webhooks/telegram.",
    },
    AGENT_R0538: {
      ...dynamicError,
      fix: "Set the URL that the message names to an HTTPS URL without a user name or password.",
    },
    AGENT_R0539: {
      ...dynamicError,
      fix: "Pass the option that the message names an HTTPS origin only, such as https://app.example.com, without credentials, a path, a query, or a fragment.",
    },
    AGENT_R0540: {
      ...dynamicError,
      fix: "Add a webhook registration to the Channel, such as webhooks: true, or remove the Channel from the sync with --channel.",
    },
    AGENT_R0541: {
      ...dynamicError,
      fix: "Give the Channel webhook registration a path or url, so that the sync knows the deployed route.",
    },
    AGENT_R0542: {
      ...dynamicError,
      fix: "Set the Channel webhook url to a URL on the confirmed deployment origin, or confirm the origin of that URL with --url and --confirm-origin.",
    },
    AGENT_R0543: {
      ...dynamicError,
      fix: "Give the Channel exactly one webhook registration, or select one with --webhook <id>.",
    },
    AGENT_R0544: {
      ...dynamicError,
      fix: "Give each Agent a different name, so that each Channel has one owner.",
    },
    AGENT_R0545: {
      ...dynamicError,
      fix: "Check that the deployed app is reachable at the URL that the message names, then run the sync again.",
    },
    AGENT_R0546: {
      ...dynamicError,
      fix: "Deploy the app version that has this Channel, and pass --url the origin of that deployment.",
    },
    AGENT_R0547: {
      ...dynamicError,
      fix: "Pass --stage <name>, such as vitehub channels sync --stage production.",
    },
    AGENT_R0548: {
      ...dynamicError,
      fix: "Pass --url <https-origin>, or set vitehub({ publicUrl }).",
    },
    AGENT_R0549: {
      ...dynamicError,
      fix: "Pass --apply or --dry-run, not both.",
    },
    AGENT_R0550: {
      ...dynamicError,
      fix: "Pass --confirm-origin with the same HTTPS origin as --url when you pass --apply.",
    },
    AGENT_R0551: {
      ...dynamicError,
      fix: "Pass --confirm-origin the exact origin of --url or of vitehub({ publicUrl }).",
    },
    AGENT_R0552: {
      ...dynamicError,
      fix: "Change --agent and --channel so that they select a Channel that has webhooks, or remove them.",
    },
    AGENT_R0553: {
      ...dynamicError,
      fix: "Give the two Channels that the message names different provider resources, such as different bot tokens or repositories, or sync them one at a time.",
    },
    AGENT_R0554: {
      ...dynamicError,
      fix: "Pass --url and --confirm-origin the origin that the provider webhook uses now, or change the webhook URL in the provider settings first.",
    },
    AGENT_R0555: {
      ...dynamicError,
      fix: "Review the plan, then run the sync again with --allow-delete to delete the webhook.",
    },
    AGENT_R0556: {
      ...dynamicError,
      fix: "Check the provider webhook settings and the Channel credentials, then run the sync again. The message shows the expected webhook URL.",
    },
    AGENT_R0557: {
      ...dynamicError,
      fix: "Set the Channel instructions to a non-empty string, or remove them.",
    },
    AGENT_R0558: {
      ...dynamicError,
      fix: "Add adapter to the Channel when you set webhooks, or start the Agent from an app-owned route.",
    },
    AGENT_R0559: {
      ...dynamicError,
      fix: "Move the Channel identity resolver to defineAgent({ messages: { identity } }), or give the Agent only one message Channel.",
    },
    AGENT_R0560: {
      ...dynamicError,
      fix: "Move the Channel messages options that the message names to defineAgent({ messages }), or give the Agent only one message Channel.",
    },
    AGENT_R0561: {
      ...dynamicError,
      fix: "Install ai 7.0.19 or newer, such as pnpm add ai@latest.",
    },
    AGENT_R0562: {
      ...dynamicError,
      fix: "Pass mcp({ servers }) or callMcpTool() an MCP client, an MCP client config, or a function that returns one.",
    },
    AGENT_R0563: {
      ...dynamicError,
      fix: "Give the MCP servers or tools names that stay different after normalization, so that no two tools get the name that the message shows.",
    },
    AGENT_R0564: {
      ...dynamicError,
      fix: "Set defineAgent({ messages: { meta } }) to a Standard Schema, such as a Valibot or Zod schema.",
    },
    AGENT_R0565: {
      ...dynamicError,
      fix: "Make the defineAgent({ messages: { meta } }) schema output an object.",
    },
    AGENT_R0566: {
      ...dynamicError,
      fix: "Build the self-hosted provider Driver on macOS or Linux on arm64 or x64.",
    },
    AGENT_R0567: {
      ...dynamicError,
      fix: "Reinstall the dependencies on the deployment host, such as pnpm install, so that the optional package that the message names is present.",
    },
    // AGENT_R0568, AGENT_R0572, AGENT_R0592, AGENT_R0600, AGENT_R0602, and AGENT_R0603 are retired. Nothing raised AGENT_R0572 or AGENT_R0592, and the developer could not reach the others. Do not reuse them.
    AGENT_R0569: {
      ...dynamicError,
      fix: "Set route.resumable.owner to a function that returns the owner of the chat.",
    },
    AGENT_R0570: {
      ...dynamicError,
      fix: "Set route.resumable.scope to \"process\".",
    },
    AGENT_R0571: {
      ...dynamicError,
      fix: "Make route.resumable.owner() return a non-empty string, such as the user ID.",
    },
    // AGENT_R0573 through AGENT_R0581 are retired with scheduled Agent turns. Do not reuse them.
    AGENT_R0582: {
      ...dynamicError,
      fix: "Clear the Agent State queue of the thread, because it has an entry that a different ViteHub version or another process wrote.",
    },
    AGENT_R0583: {
      ...dynamicError,
      fix: "Use an Agent State adapter with queuePeek() and queueReplaceHead(), or remove messages.durable or concurrency: \"steer\" from the Channel.",
    },
    AGENT_R0584: {
      ...dynamicError,
      fix: "Check that the host can reach api.telegram.org, then run the sync again. Read error.cause for the network error.",
    },
    AGENT_R0585: {
      ...dynamicError,
      fix: "Check the Telegram bot token and the webhook URL. The message shows the Telegram status and description. A retry helps only for 429 or 5xx.",
    },
    AGENT_R0586: {
      ...dynamicError,
      fix: "Set telegram({ webhookSecret }) to 1 to 256 letters, numbers, underscores, or hyphens.",
    },
    AGENT_R0587: {
      ...dynamicError,
      fix: "Pass vitehub channels sync --url <https-origin>, or set vitehub({ publicUrl }), so that the Telegram webhook gets a URL.",
    },
    AGENT_R0588: {
      ...dynamicError,
      fix: "Pass vitehub channels sync --url <https-origin>, or set vitehub({ publicUrl }), so that the Telegram webhook gets a URL.",
    },
    AGENT_R0589: {
      ...dynamicError,
      fix: "Use an HTTPS origin for the Telegram webhook, such as --url https://app.example.com.",
    },
    AGENT_R0590: {
      ...dynamicError,
      fix: "Serve the Telegram webhook on port 443, 80, 88, or 8443.",
    },
    AGENT_R0591: {
      ...dynamicError,
      fix: "Write each model price as a non-negative decimal string, such as \"0.15\".",
    },
    AGENT_R0593: {
      ...dynamicError,
      fix: "Delete the invalid delivery from the Agent webhook queue State. A different ViteHub version or another process wrote it.",
    },
    AGENT_R0594: {
      ...dynamicError,
      fix: "No change is needed when the app stops: the queue runs the delivery again. Set VITEHUB_SHUTDOWN_DRAIN_MS to let running deliveries finish first.",
    },
    AGENT_R0595: {
      ...dynamicError,
      fix: "Pass the Agent Workflow only JSON values: plain objects, arrays, strings, finite numbers, booleans, and null, without undefined, symbols, class instances, or cycles.",
    },
    AGENT_R0596: {
      ...dynamicError,
      fix: "Pass the Agent Workflow only JSON values: plain objects, arrays, strings, finite numbers, booleans, and null, without undefined, symbols, class instances, or cycles.",
    },
    AGENT_R0597: {
      ...dynamicError,
      fix: "Pass the Agent Workflow only JSON values: plain objects, arrays, strings, finite numbers, booleans, and null, without undefined, symbols, class instances, or cycles.",
    },
    AGENT_R0598: {
      ...dynamicError,
      fix: "Pass the Agent Workflow only JSON values: plain objects, arrays, strings, finite numbers, booleans, and null, without undefined, symbols, class instances, or cycles.",
    },
    AGENT_R0599: {
      ...dynamicError,
      fix: "Pass the Agent Workflow only JSON values: plain objects, arrays, strings, finite numbers, booleans, and null, without undefined, symbols, class instances, or cycles.",
    },
    AGENT_R0601: {
      ...dynamicError,
      fix: "Pass the Agent Workflow only JSON values: plain objects, arrays, strings, finite numbers, booleans, and null, without undefined, symbols, class instances, or cycles.",
    },
    AGENT_R0604: {
      ...dynamicError,
      fix: "Pass context.set() a non-empty string ID.",
    },
    AGENT_R0605: {
      ...dynamicError,
      fix: "Pass context.set() an ID that starts with a letter and has only letters, numbers, hyphens, underscores, dots, or colons, such as \"customer\".",
    },
    AGENT_R0606: {
      ...dynamicError,
      fix: "Pass { overwrite: true } to context.set() to replace the value, or use a different ID.",
    },
    AGENT_R0607: {
      ...dynamicError,
      fix: "Point the client at the Agent Invocation Stream route of an app with the same vite-hub version.",
    },
    AGENT_R0608: {
      ...dynamicError,
      fix: "Raise the stream timeout, such as vitehub agent dev --timeout 180000, or check why the Agent sent no events during that time.",
    },
    AGENT_R0618: {
      ...dynamicError,
      fix: "Pass list() a limit that is a positive integer, such as 50. The maximum is 100.",
    },
    AGENT_R0619: {
      ...dynamicError,
      fix: "Pass list() search as a string, or remove it.",
    },
    AGENT_R0620: {
      ...dynamicError,
      fix: "Pass list() a search string of 256 characters or fewer.",
    },
    AGENT_R0621: {
      ...dynamicError,
      fix: "Pass list() the cursor from the last list() result, or remove it.",
    },
    AGENT_R0622: {
      ...dynamicError,
      fix: "Pass a non-empty invocation ID string.",
    },
    AGENT_R0623: {
      ...dynamicError,
      fix: "Give defineAgentInvocations() a store with claim(), create(), get(), getSummary(), getClaimToken(), list(), release(), and update().",
    },
    AGENT_R0624: {
      ...dynamicError,
      fix: "Correct the defineAgentInvocations() option that the message names: content and configuration take \"content\" or \"metadata\", redact and redactError take functions, enforcement takes \"best-effort\" or \"strict\", and storeTimeoutMs takes an integer from 1 to 60000.",
    },
    AGENT_R0625: {
      ...dynamicError,
      fix: "Remove the reserved trace attributes from defineAgentInvocations({ metadataContent }).",
    },
    AGENT_R0626: {
      ...dynamicError,
      fix: "List only content attribute names in defineAgentInvocations({ metadataContent }).",
    },
    AGENT_R0627: {
      ...dynamicError,
      fix: "Pass defineAgent({ invocations }) the value that defineAgentInvocations() returns.",
    },
    AGENT_R0628: {
      ...dynamicError,
      fix: "Set tablePrefix of the SQLite Agent Invocation store to start with a letter or underscore and have only letters, numbers, and underscores.",
    },
    AGENT_R0629: {
      ...dynamicError,
      fix: "Pass list() a limit that is a positive integer, such as 50. The maximum is 100.",
    },
    AGENT_R0630: {
      ...dynamicError,
      fix: "Pass list() search as a string, or remove it.",
    },
    AGENT_R0631: {
      ...dynamicError,
      fix: "Pass list() a search string of 256 characters or fewer.",
    },
    AGENT_R0632: {
      ...dynamicError,
      fix: "Set maxAge, maxRecords, and maxSize of the SQLite Agent Invocation store to valid values or false, and use maxSize only with a local database file.",
    },
    AGENT_R0633: {
      ...dynamicError,
      fix: "Pass the SQLite Agent Invocation store a url or a client.",
    },
    AGENT_R0634: {
      ...dynamicError,
      fix: "Raise maxAge or maxRecords of the SQLite Agent Invocation store, so that retention keeps the record while the Invocation runs.",
    },
    AGENT_R0635: {
      ...dynamicError,
      fix: "Pass list() the cursor from the last list() result, or remove it.",
    },
    AGENT_R0636: {
      ...dynamicError,
      fix: "Pass the Agent Invoker as an object with a non-empty string id, such as { id: \"user-1\" }.",
    },
    AGENT_R0637: {
      ...dynamicError,
      fix: "Give the Agent Invoker a non-empty string id, such as { id: \"user-1\" }.",
    },
    AGENT_R0638: {
      ...dynamicError,
      fix: "Give the Agent Invoker meta as a plain object, such as meta: { team: \"support\" }, or remove meta.",
    },
    AGENT_R0639: {
      ...dynamicError,
      fix: "Pass defineAgent({ invoker: { profiles } }) an array of Agent Invoker objects, or remove profiles.",
    },
    AGENT_R0640: {
      ...dynamicError,
      fix: "Give each Agent Invoker Profile in defineAgent({ invoker: { profiles } }) a different id.",
    },
    AGENT_R0641: {
      ...dynamicError,
      fix: "Pass defineAgent({ invoker }) an object, such as { profiles, resolve }, or remove invoker.",
    },
    AGENT_R0642: {
      ...dynamicError,
      fix: "Pass defineAgent({ invoker: { resolve } }) a function that returns the Agent Invoker, or remove resolve.",
    },
    AGENT_R0643: {
      ...dynamicError,
      fix: "Select an Agent Invoker Profile id that defineAgent({ invoker: { profiles } }) defines, or add a profile with the id that the message names.",
    },
    // AGENT_R0644 and AGENT_R0645 are retired with scheduled Agent turn reauthorization. Do not reuse them.
    AGENT_R0669: {
      ...dynamicError,
      fix: "Replace the symbolic link that the message names with a real directory in the provider working directory, or remove it.",
    },
    AGENT_R0670: {
      ...dynamicError,
      fix: "Rename or remove the file that the message names, so ViteHub can create a directory at that path in the provider working directory.",
    },
    AGENT_R0671: {
      ...dynamicError,
      fix: "Rename or remove the directory or special entry at the path that the message names, so ViteHub can write its provider file there.",
    },
    AGENT_R0672: {
      ...dynamicError,
      fix: "Make the codexDriver() or claudeCodeDriver() env option return an object, such as { NODE_ENV: \"production\" }.",
    },
    AGENT_R0673: {
      ...dynamicError,
      fix: "Give each value of the codexDriver() or claudeCodeDriver() env option a string or undefined, such as String(port).",
    },
    AGENT_R0674: {
      ...dynamicError,
      fix: "Make driver.launch return { command } with a non-empty command, and give onExit and prepare only functions.",
    },
    AGENT_R0675: {
      ...dynamicError,
      fix: "Give driver.launch args an array of strings, such as [\"--port\", \"3000\"], or remove args.",
    },
    AGENT_R0676: {
      ...dynamicError,
      fix: "Remove driver.launch on Windows, or run the server on Linux or macOS.",
    },
    AGENT_R0677: {
      ...dynamicError,
      fix: "Restart the server process to use the Codex credential profile again. Check the Codex Driver logs for the reason that its runtime stopped.",
    },
    AGENT_R0678: {
      ...dynamicError,
      fix: "Make codexDriver({ credentials }) return the content of the Codex auth.json, for example from a Server Env secret.",
    },
    AGENT_R0679: {
      ...dynamicError,
      fix: "Make codexDriver({ credentials }) return the full content of the Codex auth.json as valid JSON.",
    },
    AGENT_R0680: {
      ...dynamicError,
      fix: "Make codexDriver({ credentials }) return the Codex auth.json, a JSON object, not an array or a single value.",
    },
    AGENT_R0681: {
      ...dynamicError,
      fix: "Replace the symbolic link that the message names with a regular file, or remove it, in .vitehub/data/codex/<credentialProfile>.",
    },
    AGENT_R0682: {
      ...dynamicError,
      fix: "Replace the config.toml that the message names with a regular file that has no hard links, or remove it.",
    },
    AGENT_R0683: {
      ...dynamicError,
      fix: "Make the config.toml that the message names smaller than the size in the message, or remove it.",
    },
    AGENT_R0684: {
      ...dynamicError,
      fix: "Do not change TMPDIR while the server runs, and remove the directory that the message names by hand.",
    },
    AGENT_R0685: {
      ...dynamicError,
      fix: "Replace the symbolic link that the message names with a real directory, or remove it, under .vitehub/data/codex.",
    },
    AGENT_R0686: {
      ...dynamicError,
      fix: "Remove the file that the message names, so ViteHub can create the .vitehub/data/codex/<credentialProfile> directory.",
    },
    AGENT_R0687: {
      ...dynamicError,
      fix: "Remove the .vitehub-seed.sha256 entry that the message names. ViteHub writes it again on the next Invocation.",
    },
    AGENT_R0688: {
      ...dynamicError,
      fix: "Remove the .vitehub-seed.sha256 file that the message names. ViteHub writes it again on the next Invocation.",
    },
    AGENT_R0689: {
      ...dynamicError,
      fix: "Replace the auth.json that the message names with a regular file that has no hard links, or remove it so ViteHub writes it again from codexDriver({ credentials }).",
    },
    AGENT_R0690: {
      ...dynamicError,
      fix: "Remove codexDriver({ credentials }) on Windows and sign in to Codex on the host, or run the server on Linux or macOS.",
    },
    AGENT_R0691: {
      ...dynamicError,
      fix: "Restart the server process to use this Codex credential profile again. Read error.cause for the reason that the previous Codex runtime did not stop.",
    },
    AGENT_R0692: {
      ...dynamicError,
      fix: "Restart the server process to use this Codex credential profile again. Read error.cause for the reason that the previous Codex runtime did not stop.",
    },
    AGENT_R0693: {
      ...dynamicError,
      fix: "Do not change TMPDIR while the server runs, and remove the directory that the message names by hand.",
    },
    AGENT_R0694: {
      ...dynamicError,
      fix: "Check that the server can delete files in TMPDIR, then remove the vitehub-provider- directory in TMPDIR by hand.",
    },
    AGENT_R0695: {
      ...dynamicError,
      fix: "Give each tool of a Provider Agent Driver an inputSchema that converts to JSON Schema, such as a Zod or Valibot object schema or a JSON Schema object.",
    },
    AGENT_R0696: {
      ...dynamicError,
      fix: "Give the Agent tool that the message names an inputSchema that implements Standard Schema, such as a Zod or Valibot schema, or a JSON Schema object.",
    },
    AGENT_R0697: {
      ...dynamicError,
      fix: "Change the tool call input so it matches the inputSchema of the Agent tool that the message names, or change that inputSchema.",
    },
    AGENT_R0698: {
      ...dynamicError,
      fix: "Change the tool call input so it matches the inputSchema of the Agent tool that the message names. The message lists the schema errors.",
    },
    // AGENT_R0720, AGENT_R0742, AGENT_R0743, AGENT_R0749, AGENT_R0750, AGENT_R0752 through AGENT_R0754, and AGENT_R0759 through AGENT_R0765 are retired. Nothing raised them. AGENT_R0699, AGENT_R0712, AGENT_R0717, and AGENT_R0724 are retired: only a ViteHub bug reached them. Do not reuse them.
    AGENT_R0700: {
      ...dynamicError,
      fix: "Give the Agent a Workspace whose driver supports Workspace Sessions (startSession), or use a model-backed Driver.",
    },
    AGENT_R0701: {
      ...dynamicError,
      fix: "Run the Agent with a Provider Driver and a Workspace on a Linux or macOS Node host, or remove the Workspace.",
    },
    AGENT_R0702: {
      ...dynamicError,
      fix: "Send a smaller attachment, or raise driver.execution.attachments.maxBytes.",
    },
    AGENT_R0703: {
      ...dynamicError,
      fix: "Give the attachment fetchData() in the Channel adapter or the message, so the app downloads the URL. A Provider Driver does not fetch URLs.",
    },
    AGENT_R0704: {
      ...dynamicError,
      fix: "Give the attachment inline data or a fetchData() function.",
    },
    AGENT_R0705: {
      ...dynamicError,
      fix: "Send a smaller attachment, or raise driver.execution.attachments.maxBytes.",
    },
    AGENT_R0706: {
      ...dynamicError,
      fix: "Send a smaller attachment, or raise driver.execution.attachments.maxBytes.",
    },
    AGENT_R0707: {
      ...dynamicError,
      fix: "Send a smaller attachment, or raise driver.execution.attachments.maxBytes.",
    },
    AGENT_R0708: {
      ...dynamicError,
      fix: "Send only image attachments to a Provider Driver, or use a model-backed Driver for other files.",
    },
    AGENT_R0709: {
      ...dynamicError,
      fix: "Run a Provider Driver, such as codexDriver(), on a Node.js host, or use a model-backed Driver on Cloudflare Workers and Deno.",
    },
    AGENT_R0710: {
      ...dynamicError,
      fix: "Remove the model-specific Provider Tools from this Agent. Use Capability tools with codexDriver() or claudeCodeDriver().",
    },
    AGENT_R0711: {
      ...dynamicError,
      fix: "Set the Invocation timeout to 2147483647 milliseconds or less.",
    },
    AGENT_R0713: {
      ...dynamicError,
      fix: "Remove CODEX_HOME from the env of codexDriver(), because codexDriver({ credentials }) sets it.",
    },
    AGENT_R0714: {
      ...dynamicError,
      fix: "Remove T3CODE_CODEX_LAUNCH_ARGS from the env of codexDriver(), or remove reasoningEffort and reasoningSummary.",
    },
    AGENT_R0715: {
      ...dynamicError,
      fix: "Set driver.sessionStorePath to a non-empty directory path, or remove it.",
    },
    AGENT_R0716: {
      ...dynamicError,
      fix: "Set driver.providerSettings.binaryPath to the provider command as a string, such as \"codex\", or remove it.",
    },
    AGENT_R0718: {
      ...dynamicError,
      fix: "Send a prompt, a user message, or an image attachment to the Agent.",
    },
    AGENT_R0719: {
      ...dynamicError,
      fix: "Run the Invocation again. If it fails again, check that the provider command runs and is signed in, for example with codex login status.",
    },
    AGENT_R0721: {
      ...dynamicError,
      fix: "Run the Invocation again. If it fails again, read the reason in the message and check that the provider command runs and is signed in.",
    },
    AGENT_R0722: {
      ...dynamicError,
      fix: "Run the Invocation again. If the provider aborts again, read the reason in the message and check the provider account and its limits.",
    },
    AGENT_R0723: {
      ...dynamicError,
      fix: "Run the Invocation again. If it fails again, restart the server, so the provider runtime starts clean.",
    },
    AGENT_R0725: {
      ...dynamicError,
      fix: "Restart the server, so the provider runtime starts clean, then run the Invocation again.",
    },
    AGENT_R0726: {
      why: ({ message }: { message?: unknown }) => {
        const reason = String(message ?? "");
        try {
          const payload: unknown = JSON.parse(reason);
          if (payload !== null && typeof payload === "object" && "error" in payload) {
            const providerError = payload.error;
            if (providerError !== null && typeof providerError === "object" && "message" in providerError) {
              const providerMessage = providerError.message;
              if (typeof providerMessage === "string") return providerMessage;
            }
          }
        } catch {}
        return reason;
      },
      fix: ({ message }: { message?: unknown }) => {
        const reason = String(message ?? "");
        if (/requires a newer version of Codex/i.test(reason)) return "Upgrade the Codex CLI in the Agent runner and redeploy it, then start a new run.";
        if (/configured model|model .*support/i.test(reason)) return "Choose a configured model supported by the installed provider, or update the provider runtime, then start a new run.";
        if (/spend.?cap|spend(ing)? limit|budget.*exceed/i.test(reason)) return "Raise the provider workspace spending limit or wait for its billing reset, then start a new run.";
        if (/rate.?limit|too many requests|quota.*exhaust/i.test(reason)) return "Wait for the provider quota to reset, then retry. Reduce concurrent runs if this keeps happening.";
        if (/unauthori[sz]ed|authentication|signed out|invalid.api.key/i.test(reason)) return "Sign in again or update the provider credential, then retry.";
        return "Check the provider diagnostic details and service status before retrying.";
      },
    },
    AGENT_R0727: {
      ...dynamicError,
      fix: "Pass a non-empty run id to the Agent Run Events call.",
    },
    AGENT_R0728: {
      ...dynamicError,
      fix: "Pass an event object with a non-empty type, such as { type: \"progress\" }.",
    },
    AGENT_R0729: {
      ...dynamicError,
      fix: "Make the defineAgentRunEvents({ store }) store have append(), read(), and subscribe() functions.",
    },
    AGENT_R0730: {
      ...dynamicError,
      fix: "Pass defineAgentRunEvents() an object with a store.",
    },
    AGENT_R0731: {
      ...dynamicError,
      fix: "Pass defineAgent({ runEvents }) the value that defineAgentRunEvents() returns.",
    },
    AGENT_R0732: {
      ...dynamicError,
      fix: "Set createProcessAgentCapacity({ concurrency }) to a positive integer, such as 4.",
    },
    AGENT_R0733: {
      ...dynamicError,
      fix: "Set createProcessAgentCapacity({ fallbackConcurrency }) to an integer from 0 to concurrency.",
    },
    AGENT_R0734: {
      ...dynamicError,
      fix: "Set createProcessAgentCapacity({ intervalMs }) to a number from 100 to 2147483647.",
    },
    AGENT_R0735: {
      ...dynamicError,
      fix: "Set createProcessAgentCapacity({ rampUp }) to a positive integer, such as 1.",
    },
    AGENT_R0736: {
      ...dynamicError,
      fix: "Set createProcessAgentCapacity({ sampleTimeoutMs }) to a positive number no greater than 2147483647.",
    },
    AGENT_R0737: {
      ...dynamicError,
      fix: "Set createProcessAgentCapacity({ memory: { perInvocationBytes } }) to a positive number of bytes.",
    },
    AGENT_R0738: {
      ...dynamicError,
      fix: "Set createProcessAgentCapacity({ memory }) reserveBytes and serviceReserveBytes to zero or a positive number of bytes.",
    },
    AGENT_R0739: {
      ...dynamicError,
      fix: "Pass createProcessAgentCapacity({ sample }) a function, or remove sample.",
    },
    AGENT_R0740: {
      ...dynamicError,
      fix: "Set createProcessAgentCapacity() cpu.pausePressure and memory.pausePressure to a number from 0 to 1.",
    },
    AGENT_R0741: {
      ...dynamicError,
      fix: "Set createProcessAgentCapacity() cpu.resumePressure and memory.resumePressure to a number from 0 to the pausePressure of the same option.",
    },
    AGENT_R0744: {
      ...dynamicError,
      fix: "Return only JSON values from the Agent, such as strings, numbers, arrays, and plain objects. Convert a Date with toISOString().",
    },
    AGENT_R0745: {
      ...dynamicError,
      fix: "Throw an Error object, not a string or another value, from the Agent, its tools, and its Driver. Read error.cause for the value that was thrown.",
    },
    AGENT_R0746: {
      ...dynamicError,
      fix: "Throw an Error that is not frozen from the Agent, its tools, and its Driver. Read error.cause for the original error.",
    },
    AGENT_R0747: {
      ...dynamicError,
      fix: "Keep the Agent Invocations store that recorded the Channel delivery. If you changed or cleared it, start a new Invocation from the Channel.",
    },
    AGENT_R0768: {
      ...dynamicError,
      fix: "Set route maxBodyBytes to a positive integer no greater than 10 MiB (10485760), or remove it to use 1 MiB.",
    },
    AGENT_R0769: {
      ...dynamicError,
      fix: "Make the chat trigger return a ReadableStream of UI message parts or a Response with a body.",
    },
    AGENT_R0770: {
      ...dynamicError,
      fix: "Check the webhook timeout of the Channel platform. It closed the response before the Agent finished, so return the response before that timeout.",
    },
    AGENT_R0771: {
      ...dynamicError,
      fix: "Check the webhook timeout of the Channel platform. It closed the response before the Agent finished, so return the response before that timeout.",
    },
    AGENT_R0772: {
      ...dynamicError,
      fix: "Make the get() of your Channel State adapter return the string that setIfNotExists() stored for the same key.",
    },
    AGENT_R0773: {
      ...dynamicError,
      fix: "Set webhook.concurrencyLimit in the trigger result to a positive integer, such as 1.",
    },
    AGENT_R0774: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0775: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0776: {
      ...dynamicError,
      fix: "Fix the webhook option that the message names: webhook.debounce needs a non-empty key and a delayMs of 0 or more and does not work with busy: \"steer\", concurrencyTtlMs needs a positive number, and ackTimeoutMs needs 0 or more or false.",
    },
    AGENT_R0777: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0778: {
      ...dynamicError,
      fix: "Run this Agent inline, without a durable Workflow runtime, while it has queued webhook deliveries, or clear those deliveries from the webhook State.",
    },
    AGENT_R0779: {
      ...dynamicError,
      fix: "Keep the webhook trigger that the message names in the Agent Definition until its queued deliveries finish, or clear those deliveries from the webhook State.",
    },
    AGENT_R0780: {
      ...dynamicError,
      fix: "Make the webhook trigger return an invocation, not a handled Response, for a request that it marked with webhook.rehydrate.",
    },
    AGENT_R0781: {
      ...dynamicError,
      fix: "Keep webhook.rehydrate in the webhook trigger result while deliveries that need it are queued.",
    },
    AGENT_R0782: {
      ...dynamicError,
      fix: "Make the webhook trigger return the same webhook.deliveryId each time it reads the same request.",
    },
    AGENT_R0783: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0784: {
      ...dynamicError,
      fix: "Read the message for the error that the provider or Driver sent. Check the provider credentials and the model of the Agent Definition, then send the request again.",
    },
    AGENT_R0785: {
      ...dynamicError,
      fix: "Read the message for the error that the provider or Driver sent. Check the provider credentials and the model of the Agent Definition, then send the request again.",
    },
    AGENT_R0786: {
      ...dynamicError,
      fix: "Read the message for the error that the provider or Driver sent. Check the provider credentials and the model of the Agent Definition, then send the request again.",
    },
    AGENT_R0787: {
      ...dynamicError,
      fix: "Call connect() on the Agent State before you use it. A Channel does this when it starts, so check that your code does not use the State before that.",
    },
    AGENT_R0788: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0789: {
      ...dynamicError,
      fix: "Read the message for why the steered message failed, then send it again. `vitehub agent invocations` lists the failed Invocation.",
    },
    AGENT_R0790: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0791: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0792: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0793: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0794: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0795: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0796: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0797: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0798: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0799: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0800: {
      ...dynamicError,
      fix: "Read the message for why the steered message failed, then send it again. `vitehub agent invocations` lists the failed Invocation.",
    },
    AGENT_R0801: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0802: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0803: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer. Read error.cause for the first error.",
    },
    AGENT_R0804: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0805: {
      ...dynamicError,
      fix: "Keep the Chat adapter of this Channel in the Agent Definition until its queued deliveries finish.",
    },
    AGENT_R0806: {
      ...dynamicError,
      fix: "Check that the bot can post in this thread of the Chat platform, and raise defineAgent({ messages: { timeout } }) if the platform answers slowly.",
    },
    AGENT_R0807: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0808: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0809: {
      ...dynamicError,
      fix: "Keep the Agent Invocations store that recorded the Channel delivery. If you changed or cleared it, the delivery cannot settle, so send the message again.",
    },
    AGENT_R0810: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0811: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0812: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0813: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0814: {
      ...dynamicError,
      fix: "Send a text attachment of 8 MiB (8388608 bytes) or less.",
    },
    AGENT_R0815: {
      ...dynamicError,
      fix: "Send a text attachment of 8 MiB (8388608 bytes) or less.",
    },
    AGENT_R0816: {
      ...dynamicError,
      fix: "Make the attachment fetchData() in the Chat adapter return a Blob, ArrayBuffer, Uint8Array, or string.",
    },
    AGENT_R0817: {
      ...dynamicError,
      fix: "Read error.cause for the error of the attachment fetchData() in the Chat adapter. A retry helps only for network errors.",
    },
    AGENT_R0818: {
      ...dynamicError,
      fix: "Use a Chat adapter whose posted messages have a delete() function, so ViteHub can remove the placeholder of a stopped answer.",
    },
    AGENT_R0819: {
      ...dynamicError,
      fix: "Check that the bot may delete its own messages in this Chat platform thread. Read error.cause for the platform error.",
    },
    AGENT_R0820: {
      ...dynamicError,
      fix: "Send the message again. If it fails again, check that every server instance uses the same durable Channel State and raise defineAgent({ messages: { timeout } }) if the Agent needs more time.",
    },
    AGENT_R0821: {
      ...dynamicError,
      fix: "Give the Channel a durable State, such as createLibsqlAgentState(), or use the State provider of the generated host.",
    },
    AGENT_R0822: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0823: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0824: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0825: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0826: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0827: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0828: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0829: {
      ...dynamicError,
      fix: "Check that the Agent Workflow runtime starts and that every server instance uses the same durable Channel State. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0830: {
      ...dynamicError,
      fix: "Check that the Agent Workflow runtime starts and that every server instance uses the same durable Channel State. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0831: {
      ...dynamicError,
      fix: "Check that the Agent Workflow runtime starts and that every server instance uses the same durable Channel State. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0832: {
      ...dynamicError,
      fix: "Check that the Agent Workflow runtime starts and that every server instance uses the same durable Channel State. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0833: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer. Read error.cause for the first error.",
    },
    AGENT_R0834: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0835: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer. Read error.cause for the first error.",
    },
    AGENT_R0836: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer. Read error.cause for the first error.",
    },
    AGENT_R0837: {
      ...dynamicError,
      fix: "Make the history iterator of the Channel adapter return { done, value } results.",
    },
    // AGENT_R0838 is retired. Nothing raised it. AGENT_R0842 is retired: only a ViteHub bug reached it. Do not reuse them.
    AGENT_R0839: {
      ...dynamicError,
      fix: "Use a Chat adapter that handles webhooks for this Channel, or use its polling or gateway route.",
    },
    AGENT_R0840: {
      ...dynamicError,
      fix: "Set the Channel route to true or to an object of chat route options, or remove route.",
    },
    AGENT_R0841: {
      ...dynamicError,
      fix: "Set route on only one Channel of the Agent, or create one chat route per Channel.",
    },
    AGENT_R0843: {
      ...dynamicError,
      fix: "Check that every server instance uses the same durable Channel State, such as libSQL or Durable Objects, and that it answers before its locks expire. Send the message again if the Channel shows no answer.",
    },
    AGENT_R0844: {
      ...dynamicError,
      fix: "Open the Agent Invocation in the Console or run vitehub agent invocations to read why the Agent Workflow failed, then send the message again.",
    },
    AGENT_R0845: {
      ...dynamicError,
      fix: "Update the chat package (Chat SDK) to a version whose Chat has initialize(), or use a webhook route for this Channel.",
    },
    AGENT_R0846: {
      ...dynamicError,
      fix: "Make the adapter option of the Telegram polling Channel return a Chat adapter, such as the Telegram adapter with its bot token.",
    },
    AGENT_R0847: {
      ...dynamicError,
      fix: "Add the CHAT_STATE Durable Object binding to the Cloudflare Worker, or pass namespace to the Cloudflare Agent State.",
    },
    AGENT_R0848: {
      ...dynamicError,
      fix: "Call connect() on the Agent State before you use it. A Channel does this when it starts, so check that your code does not use the State before that.",
    },
    AGENT_R0849: {
      ...dynamicError,
      fix: "Use letters, digits, and underscores in the SQLite Agent State tablePrefix, starting with a letter or underscore, and lowercase letters, digits, and underscores in extension names.",
    },
    AGENT_R0850: {
      ...dynamicError,
      fix: "Pass a driver to the SQLite Agent State, or use createLibsqlAgentState({ url }).",
    },
    AGENT_R0851: {
      ...dynamicError,
      fix: "Call connect() on the Agent State before you use it. A Channel does this when it starts, so check that your code does not use the State before that.",
    },
    AGENT_R0852: {
      ...dynamicError,
      fix: "Pass url or client to createLibsqlAgentState(), such as createLibsqlAgentState({ url: \"file:.data/agent-state.db\" }).",
    },
    AGENT_R0853: {
      ...dynamicError,
      fix: "Call connect() on the Agent State before you use it. A Channel does this when it starts, so check that your code does not use the State before that.",
    },
    AGENT_R0854: {
      ...dynamicError,
      fix: "Call connect() on the Agent State before you use it. A Channel does this when it starts, so check that your code does not use the State before that.",
    },
    AGENT_R0855: {
      ...dynamicError,
      fix: "Pass createLibsqlAgentState({ client }) a libSQL client that has transaction(), such as the client of @libsql/client, or pass url.",
    },
    AGENT_R0856: {
      ...dynamicError,
      fix: "Read the message for the error that the provider or Driver sent. Check the provider credentials and the model of the Agent Definition, then send the request again.",
    },
    AGENT_R0857: {
      ...dynamicError,
      fix: "Read the message for the error that the provider or Driver sent. Check the provider credentials and the model of the Agent Definition, then send the request again.",
    },
    AGENT_R0858: {
      ...dynamicError,
      fix: "Make the Agent result have toUIMessageStream(), return an async iterable or text, or use another stream output than \"ui-message-stream\".",
    },
    AGENT_R0859: {
      ...dynamicError,
      fix: "Send less binary data in telemetry attributes, such as smaller Blob or Uint8Array values.",
    },
    AGENT_R0860: {
      ...dynamicError,
      fix: "Send only real Blob values in telemetry attributes.",
    },
    AGENT_R0861: {
      ...dynamicError,
      fix: "Send only real File values in telemetry attributes.",
    },
    AGENT_R0862: {
      ...dynamicError,
      fix: "Send less telemetry data in one batch, such as fewer or smaller attributes. One OTLP/HTTP JSON request can be at most 4 MiB.",
    },
    AGENT_R0863: {
      ...dynamicError,
      fix: "Check that otlp({ endpoint }) points to an OTLP/HTTP JSON collector that the server can reach. ViteHub tried 3 times. Read error.cause for the network error.",
    },
    AGENT_R0864: {
      ...dynamicError,
      fix: "Check that otlp({ endpoint }) points to an OTLP/HTTP JSON collector that the server can reach. The collector answered with a body that is not JSON.",
    },
    AGENT_R0865: {
      ...dynamicError,
      fix: "Read the collector logs for the rejected spans or log records, and check that the collector accepts their attributes.",
    },
    AGENT_R0866: {
      ...dynamicError,
      fix: "Check that otlp({ endpoint }) points to an OTLP/HTTP JSON collector that the server can reach. Check the headers and the token of the collector. ViteHub retries 429, 502, 503, and 504 answers.",
    },
    AGENT_R0867: {
      ...dynamicError,
      fix: "Mount the Workspace Sources that hold the evidence that the prompt asks for, or change the prompt.",
    },
    AGENT_R0868: {
      ...dynamicError,
      fix: "Give each trigger a non-empty name, such as \"review-pr\".",
    },
    AGENT_R0869: {
      ...dynamicError,
      fix: "Name each trigger with a letter followed by letters, digits, -, or _, such as \"review-pr\".",
    },
    AGENT_R0870: {
      ...dynamicError,
      fix: "Give each trigger of the Channel that the message names a different name, or list that Channel only once in defineAgent({ channels }).",
    },
    AGENT_R0871: {
      ...dynamicError,
      fix: "Use a trigger id that a Channel of this Agent defines, such as \"slack.message\".",
    },
    AGENT_B0002: {
      ...dynamicError,
      fix: "Rename one of the two Agent files that the message names. ViteHub takes the Agent name from the file path under server/agents/ or from the name of a `*.agent.ts` file.",
    },
    // AGENT_B0003 and AGENT_B0004 are retired with Runtime Schedule targets. Do not reuse them.
    AGENT_B0005: {
      ...dynamicError,
      fix: "Set `vitehub({ agent: { providers: { state: { url } } } })` to a remote libSQL URL, such as a `libsql://` URL, with `authToken` when the database needs one.",
    },
    AGENT_B0006: {
      ...dynamicError,
      fix: "Give each of the two routes that the message names its own path. Change `inspection` or the alias path in `vitehub({ agent: { routes } })`, or move the app route to another path.",
    },
    // AGENT_B0007 through AGENT_B0015 are retired with the Eve extension adapter. Do not reuse them.
    AGENT_B0016: {
      ...dynamicError,
      fix: "Put `[agent]` in the inspection route, such as `vitehub({ agent: { routes: { inspection: \"/_vitehub/agents/[agent]/inspection\" } } })`, or set `inspection: true` to use that default route.",
    },
    AGENT_B0017: dynamicError,
    // AGENT_B0018 is retired with the Eve extension adapter. Do not reuse it.
    AGENT_B0022: {
      ...dynamicError,
      fix: "Build the app for the Node host with `vitehub({ host: \"node\" })`, or remove the process host preset from the Agents that the message names.",
    },
    AGENT_B0023: {
      ...dynamicError,
      fix: "Set `driver` in `vitehub({ agent: { providers: { state } } })` to `\"auto\"`, `\"sqlite\"`, or `\"libsql\"`, or remove `driver` to use `\"auto\"`.",
    },
    AGENT_B0024: {
      ...dynamicError,
      fix: "Write `channels` in `defineAgent()`, and `path` and `aliases` in the Channel adapter, as string literals or same-module `const` values, and correct any syntax error in the file that the message names. ViteHub reads these files without running them.",
    },
    AGENT_INVOCATION_DRIVER_INTERRUPTED: {
      why: ({ id }: { id: string }) => `[vitehub] Agent Invocation ${JSON.stringify(id)} was interrupted while its Driver ran, and ViteHub did not run the Driver again. A second run could repeat model calls and tool side effects.`,
      fix: "Start a new turn. Before you do, check the work that the interrupted Driver did, such as tool calls with side effects. The journal record and its observations show how far it got.",
    },
    AGENT_R0872: {
      ...dynamicError,
      fix: "Keep the Agent Dev Loop client connected until the Invocation ends, then run the request again.",
    },
    AGENT_R0873: {
      ...dynamicError,
      fix: "Keep the Agent Dev Loop client connected until the command ends, then run the command again.",
    },
    AGENT_R0874: {
      ...dynamicError,
      fix: "Use a Workspace store provider that this dev server installs, such as \"github\", in the store option of the Workspace Definition.",
    },
    AGENT_R0875: {
      ...dynamicError,
      fix: "Use a Capability CLI name that a Capability of this Agent defines.",
    },
    AGENT_R0876: {
      ...dynamicError,
      fix: "Give the Agent a Workspace in defineAgent({ workspace }) before you run Dev Loop commands.",
    },
    AGENT_R0877: {
      ...dynamicError,
      fix: "Pass a longer timeout in the Agent Dev Loop request, or 0 to wait with no limit, or give the Agent less work.",
    },
    AGENT_R0878: {
      ...dynamicError,
      fix: "Give the Workspace reference a non-empty name, such as the file name of the Workspace Definition without .ts.",
    },
    AGENT_R0879: {
      ...dynamicError,
      fix: "Remove the options that the message names from the Workspace reference, or put them in the Workspace Definition.",
    },
    AGENT_R0880: {
      ...dynamicError,
      fix: "Pass defineWorkspace() an object, such as defineWorkspace({ sources }).",
    },
    AGENT_R0881: {
      ...dynamicError,
      fix: "Remove name from defineWorkspace(). ViteHub takes the Workspace name from the file name, so rename the file instead.",
    },
    AGENT_R0882: {
      ...dynamicError,
      fix: "Remove the defineWorkspace() options that the message names, and give materialize one of the values that the message lists.",
    },
    AGENT_R0883: {
      ...dynamicError,
      fix: "Give the Workspace Source that a Capability contributes a key that the Workspace Definition does not use, or remove one of the two Sources.",
    },
    // AGENT_R0884 is retired. Do not reuse it.
    AGENT_R0885: {
      ...dynamicError,
      fix: "Rename the Workspace binding \"sources\". To show Sources to the model, use ::source blocks in the Driver instructions.",
    },
    AGENT_R0886: {
      ...dynamicError,
      fix: "Rename the Workspace binding that the message names to letters, digits, _, $, and -, with dots between parts, such as \"repo.name\".",
    },
    AGENT_R0887: {
      ...dynamicError,
      fix: "Give the Agent a Workspace that this binding can read, or make the binding a string, number, boolean, or null.",
    },
    AGENT_R0888: {
      ...dynamicError,
      fix: "Make the Workspace binding that the message names a string, number, boolean, null, or { path }.",
    },
    AGENT_R0926: {
      ...dynamicError,
      fix: "Set title({ timeoutMs }) to an integer from 1 to 2147483647, or remove it.",
    },
    AGENT_R0927: {
      ...dynamicError,
      fix: "Set title({ reasoningEffort }) to a non-empty value that the model supports, such as \"low\", or remove it.",
    },
    AGENT_R0934: {
      ...dynamicError,
      fix: "Pass replayChannel() or vitehub channels replay a label of 1 to 512 characters, a positive integer limit, a non-empty cursor, a query object, and only the options that the message names.",
    },
    AGENT_R0935: {
      ...dynamicError,
      fix: "Change the history query that the message names so that the history of the Channel adapter accepts it.",
    },
    AGENT_R0936: {
      ...dynamicError,
      fix: "Pass the cursor from the last replay result, and make the history of the Channel adapter return a new cursor for each page.",
    },
    AGENT_R0937: {
      ...dynamicError,
      fix: "Set the Google OAuth env variables that the message names in Server Env, or pass gmail({ client }).",
    },
    AGENT_R0970: {
      ...dynamicError,
      fix: "Give defineAgent({ driver: { requirements } }) a list of command names, and a launch resolver when driver.launch is set. A message about a cancellation request means that someone cancelled the Invocation, so start a new one if you need it.",
    },
    AGENT_R0971: {
      ...dynamicError,
      fix: "Set defineAgent({ driver: { toolchain } }) to \"project\" or an object with node, packageManager, or fallbackNode. For vitehub agent invocations, check that --url points to a running ViteHub app that uses the same vite-hub version.",
    },
    AGENT_R0972: {
      ...dynamicError,
      fix: "Move driver.toolchain to sandbox.toolchain when the Agent has a sandbox. For vitehub agent invocations cancel, start the Vite dev server first and read the HTTP error in the message.",
    },
    AGENT_R0973: {
      ...dynamicError,
      fix: "Check that the Agent Invocations store answers within its storeTimeoutMs, or set defineAgentInvocations({ enforcement: \"best-effort\" }). Run the Invocation again when the store is fast again.",
    },
    AGENT_R0974: {
      ...dynamicError,
      fix: "Call invocations.cancel(id) again and read its result, and check that the Agent Invocations store answers fast.",
    },
    AGENT_R0976: {
      ...dynamicError,
      fix: "Use a gateway that serves this Driver, set its baseURL for the Driver, or use chatgpt() only with codexDriver() or a model-backed Driver, as the message shows.",
    },
    AGENT_R0979: {
      ...dynamicError,
      fix: "Remove the variables that the message names from driver.env, because driver.gateway sets them.",
    },
    AGENT_R0981: {
      ...dynamicError,
      fix: "Name only MCP servers that mcp({ servers }) defines in mcp({ toolOverrides }).",
    },
    AGENT_R0982: {
      ...dynamicError,
      fix: "Name only tools that the MCP server lists in mcp({ toolOverrides }), or remove the override.",
    },
    AGENT_R0983: {
      ...dynamicError,
      fix: "Give each mcp({ toolOverrides }) input schema a plain JSON Schema object with type: \"object\", without transforms.",
    },
    AGENT_R0924: {
      ...dynamicError,
      fix: "Remove --append-system-prompt-file from the Claude launchArgs and put its content in driver.instructions, or remove title({ reasoningEffort }) when the Driver is not Codex.",
    },
    AGENT_R0925: {
      ...dynamicError,
      fix: "Set title({ model }) to a non-empty model id, or remove it.",
    },
    AGENT_R0950: {
      ...dynamicError,
      fix: "Remove the file that the message names from sandbox.home.files. The provider Driver writes it.",
    },
    AGENT_R0951: {
      ...dynamicError,
      fix: "Use a Sandbox runtime that can run long processes, such as trusted-host or crabbox, in defineAgent({ sandbox }).",
    },
    AGENT_R0952: {
      ...dynamicError,
      fix: "Check that the Sandbox runtime sets HOME to an absolute path, or set it in sandbox.env.",
    },
    AGENT_R0953: {
      ...dynamicError,
      fix: "Run the Invocation again. If it fails again, check that the Sandbox network allows the relay connection of the provider Driver.",
    },
    AGENT_R0954: {
      ...dynamicError,
      fix: "Pass defineAgent({ sandbox }) a Sandbox Definition with a runtime.",
    },
    AGENT_R0955: {
      ...dynamicError,
      fix: "Use codexDriver() or claudeCodeDriver() as the driver of an Agent with a sandbox.",
    },
    AGENT_R0956: {
      ...dynamicError,
      fix: "Remove driver.launch from an Agent with a sandbox. The Sandbox starts the provider.",
    },
    AGENT_R0957: {
      ...dynamicError,
      fix: "Remove driver.credentials and driver.credentialProfile, and write the provider credentials with sandbox.home.files or sandbox.env.",
    },
    AGENT_R0958: {
      ...dynamicError,
      fix: "Remove the Workspace from an Agent with a sandbox, and use sandbox.checkout or sandbox.cwd for the working tree.",
    },
    AGENT_R0959: {
      ...dynamicError,
      fix: "Run an Agent with a sandbox on a Node.js host, not on Workers or Deno.",
    },
    AGENT_R0960: {
      ...dynamicError,
      fix: "Install the browser in the Sandbox and use browser() with a Sandbox runtime, or remove the managed browser() from the Agent with a sandbox.",
    },
    AGENT_R0961: {
      ...dynamicError,
      fix: "Use a Sandbox runtime that shares the ViteHub network, such as trusted-host or crabbox with network: \"direct\", or remove the Capability tools.",
    },
    AGENT_R0962: {
      ...dynamicError,
      fix: "Send no image attachments to an Agent with a sandbox, or remove the sandbox.",
    },
    AGENT_R0963: {
      ...dynamicError,
      fix: "Run an Agent with a sandbox on Linux or macOS.",
    },
    AGENT_R0932: {
      ...dynamicError,
      fix: "Configure Agent Invocations or the Console, or pass force to the replay. Use an Agent Invocation store that has delete() and prune(), such as a ViteHub store.",
    },
    AGENT_R0933: {
      ...dynamicError,
      fix: "Pass the history trigger when the Channel has more than one trigger, and give the value that the message names a non-empty string of at most 512 characters.",
    },
    AGENT_R0929: {
      ...dynamicError,
      fix: "Rename the Channel message method that the message names, because channel, data, and kind are reserved, or pass prune({ olderThanMs }) a non-negative safe integer.",
    },
    // AGENT_R0930, AGENT_R0931, AGENT_R0940, AGENT_R0946, and AGENT_R1025 are retired. Each of their causes has its own named code. Do not reuse them.
    AGENT_R0938: {
      ...dynamicError,
      fix: "Set defineAgent({ driver: { cwd } }) to the path or resolver of an existing directory. For a Gmail response, check the Gmail API scopes of the OAuth client and run again.",
    },
    AGENT_R0001: {
      why: ({ name, available }: { name: string, available: string[] }) => formatUnknownAgentMessage(name, available, { prefix: true }),
      fix: "Use a discovered Agent name. Check the Agent Definition and the ViteHub Agent plugin configuration.",
    },
    AGENT_R0002: {
      why: ({ name }: { name: string }) => `[vitehub] Agent "${name}" did not export a valid default agent.`,
      fix: "Export the result of defineAgent() as the default export of the Agent Definition.",
    },
    AGENT_C0001: {
      why: "[vitehub] Invalid agent definition.",
      fix: "Pass an Agent Definition created with defineAgent().",
    },
    AGENT_C0002: {
      why: "[vitehub] defineCapability() requires a capability definition.",
      fix: "Pass an object with a non-empty id to defineCapability().",
    },
    AGENT_C0003: {
      why: "[vitehub] Capability definitions require a non-empty string id.",
      fix: "Set the Capability id to a string that starts with a letter.",
    },
    AGENT_C0004: {
      why: ({ id }: { id: string }) => `[vitehub] Capability id "${id}" must be a stable identifier.`,
      fix: "Start the id with a letter. Use only letters, numbers, hyphens, underscores, and dots.",
    },
    AGENT_C0005: {
      why: ({ capability }: { capability: string }) => `[vitehub] Capability "${capability}" trigger names must be non-empty strings.`,
      fix: "Set each trigger name to a non-empty string that starts with a letter.",
    },
    AGENT_C0006: {
      why: ({ capability, name }: { capability: string, name: string }) => `[vitehub] Capability "${capability}" trigger "${name}" must be a stable local identifier.`,
      fix: "Start the trigger name with a letter. Use only letters, numbers, hyphens, and underscores.",
    },
    AGENT_C0007: {
      why: ({ label }: { label: string }) => `[vitehub] ${label} mode must be "read" or "write".`,
      fix: 'Set mode to "read" or "write", or omit it to use "read".',
    },
    AGENT_C0008: {
      why: "[vitehub] defineAgent({ capabilities }) must be an ordered array.",
      fix: "Pass an array of Capabilities in execution order.",
    },
    // AGENT_B0001 is retired with the Eve extension adapter. Do not reuse it.
    AGENT_B0020: {
      why: ({ root }: { root: string }) => `[vitehub] Cannot identify the owning Agent build for ${JSON.stringify(root)} because its environment does not uniquely match a resolved configuration.`,
      fix: "Use a separate Agent plugin instance per build or preserve the resolved build options in each environment config.",
    },
    AGENT_B0019: {
      why: "[vitehub] Provider Agent Drivers (codexDriver() and claudeCodeDriver()) cannot run in a Cloudflare Worker. A server module in this Worker build calls one.",
      fix: "Use a { model } or { run } Driver in Worker builds, or deploy Agents that use provider Drivers to a Node.js host.",
    },
    AGENT_INVOCATIONS_NO_DEV_SERVER: {
      why: ({ root }: { root: string }) => `[vitehub] No dev server is running for ${root}, so \`vitehub agent invocations\` has no app to read.`,
      fix: "Start the dev server of this project, such as with pnpm dev. To read another app, pass --url with its app URL. To read the journal file without the app, pass --database .vitehub/data/agent-invocations.sqlite.",
    },
    AGENT_R0939: {
      why: "[vitehub] Observability is not configured.",
      fix: "Set vitehub({ observability: { service } }) in the Vite config.",
    },
    AGENT_R0947: {
      why: ({ requested, actual }: { requested: string; actual: string }) => `[vitehub] SQLite journal mode ${requested} was requested, but the VFS retained ${actual}.`,
      fix: "Use a local VFS that supports the requested journal mode. Set journalMode to delete for volumes that support rollback journaling only.",
    },
    AGENT_R0941: {
      ...dynamicError,
      fix: "Set the Forge credentials that the message names in Server Env, such as VITEHUB_GITHUB_TOKEN.",
    },
    AGENT_R0942: {
      ...dynamicError,
      fix: "Add the repository to forge({ repositories }), or use a repository from that list.",
    },
    AGENT_R0943: {
      ...dynamicError,
      fix: "Set forge({ repositories }), or run the Agent in a pull request of the same forge, and pass repository when repositories lists more than one.",
    },
    AGENT_R0944: {
      ...dynamicError,
      fix: "Check that the Forge token can read the repository and that the forge supports the operation that the message names. Read only text files with the Forge file tool.",
    },
    AGENT_R0945: {
      ...dynamicError,
      fix: "Call the Forge tool that the message names with input that matches its schema.",
    },
    AGENT_R0991: {
      ...dynamicError,
      fix: "Give the Forge Channel sync.repositories a non-empty list of owner/name paths, such as [\"acme/app\"].",
    },
    AGENT_R0992: {
      ...dynamicError,
      fix: "Pass token to the Forge webhook sync, or set the VITEHUB_<FORGE>_TOKEN variable that the message names.",
    },
    AGENT_R0993: {
      ...dynamicError,
      fix: "Pass webhookSecret to the Forge webhook sync, or set the VITEHUB_<FORGE>_WEBHOOK_SECRET variable that the message names.",
    },
    AGENT_R0994: {
      ...dynamicError,
      fix: "Give the Forge token permission to manage repository webhooks, such as admin:repo_hook on GitHub.",
    },
    AGENT_R0995: {
      ...dynamicError,
      fix: "Remove the duplicate webhooks of the repository that the message names in the forge settings, then run the sync again.",
    },
    AGENT_R0996: {
      ...dynamicError,
      fix: "Check that the Forge token can manage webhooks of the repository. The message shows the HTTP status. A retry helps only for network errors and 5xx.",
    },
    AGENT_R0997: {
      ...dynamicError,
      fix: "Set the Forge baseUrl to the instance URL without credentials, query, or fragment, and pass the public app URL to the sync.",
    },
    AGENT_R0998: {
      ...dynamicError,
      fix: "Call sandbox_exec with input that matches its schema, as the message shows.",
    },
    AGENT_R0999: {
      ...dynamicError,
      fix: "Call sandbox_exec with input that matches its schema, as the message shows.",
    },
    AGENT_R1000: {
      ...dynamicError,
      fix: "Call sandbox_exec with input that matches its schema, as the message shows.",
    },
    AGENT_R1001: {
      ...dynamicError,
      fix: "Call sandbox_exec with input that matches its schema, as the message shows.",
    },
    AGENT_R1002: {
      ...dynamicError,
      fix: "Call sandbox_exec without PATH, NODE_OPTIONS, NODE_PATH, or loader variables in env.",
    },
    AGENT_R1003: {
      ...dynamicError,
      fix: "Call sandbox_exec with input that matches its schema, as the message shows.",
    },
    AGENT_R1004: {
      ...dynamicError,
      fix: "Call sandbox_exec with input that matches its schema, as the message shows.",
    },
    AGENT_R1005: {
      why: ({ trigger }: { trigger: string }) => `[vitehub] Channel trigger "${trigger}" declares durableState: true, but it ran without the Channel's State.`,
      fix: "Run the trigger through the Channel's webhook route, its webhook queue or context.dispatch(), and give the Agent a durable state provider.",
    },
    AGENT_R1007: {
      ...dynamicError,
      fix: "Set defineAgent({ messages: { loading } }) without delivery: \"manual\" when you use messages.allowSilentReply, or remove allowSilentReply.",
    },
    AGENT_R1011: {
      ...dynamicError,
      fix: "Pass content() the Content runtime that defineContent() returns, with at least one collection.",
    },
    AGENT_R1012: {
      ...dynamicError,
      fix: "Use a collection name that server/content.ts defines, as the message lists.",
    },
    AGENT_R1013: {
      ...dynamicError,
      fix: "Set driver.gateway to typesafe(), vercel(), or cloudflare() from @vite-hub/gateways, so Jev questions can run.",
    },
    AGENT_R1027: {
      ...dynamicError,
      fix: "Use maxAge or maxRecords in agent.invocations.retention on D1, or set agent.invocations.databaseUrl to a SQLite file.",
    },
    AGENT_R1028: {
      ...dynamicError,
      fix: "Add the D1 binding that the message names to the Worker, or set agent.invocations.databaseUrl.",
    },
    AGENT_R1030: {
      ...dynamicError,
      fix: "Set database in vitehub(), and run the Agent in the ViteHub server.",
    },
    AGENT_R1031: {
      ...dynamicError,
      fix: "Run the Agent in the ViteHub server, so the default journal knows the project root, or set agent.invocations to false.",
    },
    AGENT_R1032: {
      ...dynamicError,
      fix: "Rename VITEHUB_CONSOLE_DATABASE_URL to VITEHUB_AGENT_INVOCATIONS_DATABASE_URL, and its token to VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN.",
    },
    AGENT_R1033: {
      ...dynamicError,
      fix: "Call getAgentInvocations() in the ViteHub server of an app with Agents, and do not set agent.invocations to false.",
    },
    AGENT_R1034: {
      ...dynamicError,
      fix: "Set inputCommands({ debug }) to true or false.",
    },
    AGENT_R1035: {
      ...dynamicError,
      fix: "Use db.batch() for atomic writes to the D1 Agent Invocation journal, not db.transaction().",
    },
    AGENT_R1029: {
      why: "The default Agent Invocation journal cannot open a file: URL in a Cloudflare Worker.",
      fix: "Set VITEHUB_AGENT_INVOCATIONS_DATABASE_URL or agent.invocations.databaseUrl to a remote libSQL URL, or remove the file URL to use the host default journal.",
    },
    AGENT_R1036: {
      why: "The default Agent Invocation journal selected SQLite or libSQL, but the server was built without the libSQL driver.",
      fix: "Set agent.invocations.databaseUrl to the libSQL URL in the build, so a Cloudflare build includes the driver, or remove VITEHUB_AGENT_INVOCATIONS_DATABASE_URL to use D1 or memory.",
    },
    AGENT_R1024: {
      why: "The ChatGPT access token expired during this Invocation.",
      fix: "Start a new Invocation to resolve a fresh token. Review completed tool effects before retrying. ViteHub does not replay the interrupted Invocation automatically.",
    },
    AGENT_R1015: {
      why: "The ChatGPT gateway requires ViteHub to own the Codex launch and its credentials.",
      fix: "Remove driver.launch, providerSettings.launchArgs, binaryPath, homePath, shadowHomePath and sandbox when using chatgpt(). Install @openai/codex in the app and use a local Codex Driver with Capability tools.",
    },
    AGENT_R1026: {
      why: "The ChatGPT gateway cannot find Codex in this app.",
      fix: "Install @openai/codex in the app, for example pnpm add @openai/codex, and restart the server. The gateway does not run a codex command from PATH.",
    },
    AGENT_R1016: {
      why: ({ problem }: { connection: string, problem: string }) => `The ChatGPT Connection cannot provide plan access (${problem}).`,
      fix: ({ connection }: { connection: string, problem: string }) => `Enable Connections, grant this Agent read access, and run vitehub connections connect ${connection}. For invalid-user, check OpenAI status before signing in again. No API key fallback is used.`,
    },
    AGENT_R1017: {
      why: "The ChatGPT plan usage limit was reached.",
      fix: "Check https://chatgpt.com/settings/usage and wait for the limit to reset. ViteHub never switches to API billing.",
    },
    AGENT_R1018: {
      why: "This ChatGPT account is not eligible for plan usage.",
      fix: "Check the account's Plus or Pro plan and OpenAI's Sign in with ChatGPT eligibility requirements.",
    },
    AGENT_R1019: {
      why: "The ChatGPT plan endpoint rejected an unsupported capability.",
      fix: "Use function tools or web search. Remove hosted MCP, connectors, tool_search, file search, code interpreter, image generation and computer use.",
    },
    AGENT_R1020: {
      why: "ChatGPT plan usage is temporarily unavailable after bounded retries.",
      fix: "Retry later and check OpenAI status. Keep the existing grant; do not sign in repeatedly.",
    },
    AGENT_R1022: {
      why: "ChatGPT denied plan access with HTTP 403. Codex did not preserve the provider error code.",
      fix: "Check account eligibility, the issued client ID, resource and plan scopes. OpenAI may require app approval. ViteHub does not switch billing or erase the grant.",
    },
    AGENT_R1021: {
      why: "OpenAI rejected the app's ChatGPT plan configuration or request route.",
      fix: "Check the issued client ID, resource, plan scopes, POST /v1/responses route and OpenAI app eligibility. Do not retry with an API key.",
    },
    AGENT_R1023: {
      why: "ChatGPT plan inference failed without a provider error code. Codex can discard error codes from failed response streams.",
      fix: "Check https://chatgpt.com/settings/usage, OpenAI status, the selected model and Connection scopes. Review completed tool effects before retrying. ViteHub has not switched billing or erased the grant.",
    },
    AGENT_R0928: {
      why: "[vitehub] Provider Agent Drivers are not included in Worker builds. They start local Codex or Claude Code processes, which require a Node.js host.",
      fix: "Use a { model } or { run } Driver in Worker builds, or deploy Agents that use provider Drivers to a Node.js host.",
    },
    AGENT_C0009: {
      why: ({ id }: { id: string }) => `[vitehub] Duplicate capability id "${id}" in one agent.`,
      fix: "Remove the duplicate Capability or give each Capability a unique id.",
    },
    AGENT_C0010: {
      why: ({ id, unsupported }: { id: string, unsupported: string[] }) => `[vitehub] Invocation-resolved Capability "${id}" cannot contribute ${unsupported.join(", ")}. Attach definition-time behavior in a static capabilities array.`,
      fix: "Move triggers, workspaceSources, and chat access to a static capabilities array.",
    },
    AGENT_C0011: {
      why: "[vitehub] forge() requires valid forge, repositories, output limit and operations for its mode.",
      fix: "Use mode write for write operations and policy. Use repository names or owner/* patterns.",
    },
    AGENT_C0012: {
      why: "[vitehub] content() requires { collections?: string[], operations?: Array<\"read\" | \"write\" | \"publish\">, policy?, user?, lease?: \"override\" }.",
      fix: "Name each collection once, enable at least one operation, pass policy as a decision or function and user as a function, and omit lease or set it to \"override\".",
    },
    AGENT_C0013: {
      why: "[vitehub] operations() requires { include: string[], approve?, user? }.",
      fix: "List the operation names to expose, such as [\"content.*\"], and pass approve as \"destructive\", \"write\", \"all\", \"never\", a list of names, or a function.",
    },
    AGENT_C0014: {
      why: "[vitehub] i18n() requires { operations?: Array<\"read\" | \"write\" | \"publish\">, policy? }.",
      fix: "Enable at least one operation, and pass policy as a decision or a function.",
    },
    AGENT_R1014: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
      fix: "Add the integration that defines the operation, and check the name with `vitehub inspect definitions --kind operation`.",
    },
    AGENT_R1038: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
      fix: "Pass driver.workspaceWrite as { network?: boolean, packageCaches?: boolean }, or remove it.",
    },
    AGENT_R1037: {
      why: ({ name }: { name: string }) => `[vitehub] Agent "${name}" owns a Workspace, but the defineAgent() options that its file exports have no workspace key. A Capability, Channel, preset, parent, or configure callback added the Workspace. Add workspace: {} to its defineAgent() options.`,
      fix: "Add workspace: {} to the defineAgent() options in the Agent file. ViteHub reads the Workspace of a folder Agent only from this key, without running the module.",
    },
    AGENT_R1039: {
      why: ({ value }: { value: unknown }) => `[vitehub] Agent Invocation afterSequence must be a non-negative safe integer, but it is ${typeof value === "string" ? JSON.stringify(value) : String(value)}.`,
      fix: "Pass the sequence of the last observation that you read, or 0 to read all observations. Convert a value from a query string with Number() first.",
    },
    AGENT_R1040: {
      why: ({ provider }: { provider: unknown }) => `[vitehub] Unknown session provider ${JSON.stringify(provider)}. Use "codex" or "claude-code".`,
      fix: 'Pass "codex" or "claude-code" as the session provider.',
    },
    AGENT_R1041: {
      why: "[vitehub] importAgentSession() needs agentName and runId.",
      fix: "Pass non-empty agentName and runId strings in the import options.",
    },
    AGENT_R1042: {
      why: "[vitehub] importAgentSession() replaces an earlier import, and this store cannot delete records.",
      fix: "Use an Agent Invocation store that implements delete(), or choose a different runId for the import.",
    },
    AGENT_R1043: {
      why: ({ id }: { id: string }) => `[vitehub] importAgentSession() cannot replace Invocation ${id}: it is still pending or running.`,
      fix: "Wait for the existing Invocation to finish, or choose a different runId for the import.",
    },
    AGENT_R1044: {
      why: ({ registration }: { registration: string }) => `[vitehub] Webhook registration "${registration}" does not verify requests, and it does not opt out of verification.`,
      fix: "Set secretToken with secretHeader, signature: \"bearer\", or signature: { verify }. To accept unsigned requests on purpose, set secretToken: false.",
    },
    AGENT_R1045: {
      why: "[vitehub] page() reaches the page over Realtime, and this build has no Realtime driver.",
      fix: "Set `realtime: true` in the vite-hub options. A Node build needs `realtime: { driver: \"memory\" }` for one process, or Redis or Postgres for more.",
    },
    AGENT_R1046: {
      why: "[vitehub] connectPage() has no `join`, so the page cannot join its Realtime room.",
      fix: "Pass `join: connectRealtimeRoom` from `vite-hub/realtime/client`: `connectPage(createAgent, { join: connectRealtimeRoom })`.",
    },
    AGENT_R1047: {
      why: ({ step }: { step: string }) => `[vitehub] The page refused ${step}: a deny rule of page() covers it. Nothing of this step changed.`,
      fix: "Do not try this step another way. Tell the person what you wanted to change, so they can do it themselves.",
    },
    AGENT_R1048: {
      why: ({ step }: { step: string }) => `[vitehub] ${step} needs the person's approval, and the page has no way to ask them. Nothing of this step changed.`,
      fix: "Tell the person what this step does, so they can do it themselves. To let the page ask, pass `allow` to connectPage(), such as `allow: step => step.confirm ? confirm(step.confirm) : true`.",
    },
    AGENT_R1049: {
      why: ({ step }: { step: string }) => `[vitehub] The person did not approve ${step}. Nothing of this step changed.`,
      fix: "Do not run this step again. Ask the person what they want instead.",
    },
    AGENT_R1050: {
      why: "[vitehub] The page answered page_act without applying the rules of page(), so nothing ran. Its client is older than the server.",
      fix: "Reload the page. If it stays, build the app again, so the page and the server use the same vite-hub version.",
    },
    AGENT_R1051: {
      why: "[vitehub] connectPage() needs ui-sdk's `createAgent` function, so it can decide each step with the server's rules, and got something else.",
      fix: "Pass the function, not a bridge: `connectPage(createAgent, { join: connectRealtimeRoom })`. For more ui-sdk options, pass `options => createAgent({ ...options, timeout: 60_000 })`.",
    },
    AGENT_R1052: {
      why: ({ problem }: { problem: string }) => `[vitehub] page() has an invalid rule: ${problem}`,
      fix: "Give each rule in `deny` and `requireApproval` a non-empty `label`, a `component`, or `confirm: true`, such as `{ label: \"Project name\" }`.",
    },
    AGENT_R1053: {
      why: ({ url, form }: { url: string, form: string }) => `[vitehub] --url ${url} ${form}. --url is the app URL in every vitehub command. This old form stops working in the next minor version.`,
      fix: ({ use }: { use: string }) => `Pass ${use}.`,
    },
    AGENT_R1054: {
      why: "[vitehub] This page is closed. Its queued calls cannot run.",
      fix: "Reload the page or call connectPage() again to create a new connection before sending more page calls.",
    },
    AGENT_R0003: {
      why: ({ name }: { name: string }) => `[vitehub:agent] Tool "${name}" failed with a retryable policy decision.`,
      fix: "Retry the tool when its policy permits execution. Do not bypass the policy.",
    },
    // Named errors. Keep these codes in alphabetical order.
    AGENT_BROWSER_CACHE_UNTRUSTED: {
      why: ({ path }: { path: string | undefined }) => path === undefined
        ? "[vitehub] Managed browser cache ownership cannot be verified on this host."
        : `[vitehub] Managed browser cache requires trusted ownership and permissions: ${path}`,
      fix: "Make the managed browser cache directory and its parents owned by the server user and not writable by other users, or use `browser({ runtime: \"external\" })`.",
    },
    AGENT_BROWSER_INSTALL_FAILED: {
      why: ({ step }: { step: "executable" | "validation" }) => step === "executable"
        ? "[vitehub] Browser runtime installation did not produce a Chrome executable."
        : "[vitehub] Browser runtime cache validation failed after installation.",
      fix: "Delete the managed browser cache directory and run again. Check that the host can download Chrome and has free disk space.",
    },
    AGENT_BROWSER_MANAGED_WITH_LAUNCH: {
      why: ({ explicit }: { explicit: boolean }) => explicit
        ? "[vitehub] browser({ runtime: \"managed\" }) cannot be used with driver.launch because the launcher may run on another filesystem. Remove runtime, or use browser({ runtime: \"external\" }) with a browser runtime prepared by the launcher."
        : "[vitehub] Managed browser() cannot be used with driver.launch because the launcher may run on another filesystem. Use browser({ runtime: \"external\" }) with a browser runtime prepared by the launcher.",
      fix: "Use `browser({ runtime: \"external\" })` with a browser runtime that the launcher prepares, or remove `driver.launch`.",
    },
    AGENT_BROWSER_PLATFORM_UNSUPPORTED: {
      why: ({ arch }: { arch: boolean }) => arch
        ? "[vitehub] Managed browser() currently requires Linux x64. Use runtime: external for other architectures."
        : "[vitehub] Managed browser() supports Linux and macOS. Use runtime: external for a prepared browser runtime.",
      fix: "Run the managed browser on Linux x64 or macOS, or use `browser({ runtime: \"external\" })` with a browser that you prepare.",
    },
    AGENT_BROWSER_SOCKET_DIRECTORY_UNSAFE: {
      why: ({ ancestors }: { ancestors: boolean }) => ancestors
        ? "[vitehub] Browser socket directory ancestors must be private directory paths or trusted system directories."
        : "[vitehub] Browser socket directory must be a private directory owned by the current user.",
      fix: "Put the browser socket directory under a path that the server user owns, with no write access for other users, such as a private temporary directory.",
    },
    AGENT_BUDGET_CAPACITY_UNSUPPORTED: {
      why: "[vitehub] budget capability does not support capacity; configure it on defineAgent({ budget }).",
      fix: "Remove `capacity` from the `budget()` Capability and set it in `defineAgent({ budget })`.",
    },
    AGENT_BUDGET_LIMIT_INVALID: {
      why: ({ name }: { name: string }) => `[vitehub] budget ${name} must be a finite, non-negative number.`,
      fix: "Set each `budget()` limit that the message names to a finite number of 0 or more.",
    },
    AGENT_BUDGET_LIMIT_MISSING: {
      why: "[vitehub] budget requires tokens or usd.",
      fix: "Pass `tokens` or `usd` to `budget()`, such as `budget({ usd: \"0.50\" })`.",
    },
    AGENT_BUDGET_USD_INVALID: {
      why: "[vitehub] budget usd must be a non-negative decimal.",
      fix: "Set `budget({ usd })` to a decimal of 0 or more, such as `\"0.50\"` or `2`.",
    },
    AGENT_CAPABILITY_EXTEND_ID_CHANGED: {
      why: ({ id }: { id: string }) => `[vitehub] Capability "${id}" extend() must return a Capability with the same id.`,
      fix: "Return a Capability with the same `id` from the Capability `extend()` function, such as `{ ...inherited, tools }`.",
    },
    AGENT_CAPABILITY_ID_MISSING: {
      why: "[vitehub] Agent layers require explicit capability definitions with stable IDs.",
      fix: "Pass Capability objects with a string `id` in `defineAgent({ capabilities })` when the Agent uses `extends`.",
    },
    AGENT_CHANNELS_ADAPTER_MISSING: {
      why: "Channel history export could not resolve the configured Chat adapter.",
      fix: "Configure the Chat adapter of the Channel, such as its bot token, so that ViteHub can read the provider history.",
    },
    AGENT_CHANNELS_CURSOR_INVALID: {
      why: "The cursor is not valid.",
      fix: "Pass the `nextCursor` of the previous page, or omit the cursor to read the first page.",
    },
    AGENT_CHANNELS_EXPORT_TOO_LARGE: {
      why: ({ archive }: { archive: "export" | "history" }) => archive === "history" ? "Channel history archive exceeds the 35 MiB response limit." : "The conversation is larger than the 35 MiB limit of an export.",
      fix: "Export without media, or read the conversation page by page with `vitehub channels conversation`.",
    },
    AGENT_CHANNELS_FORBIDDEN: {
      why: ({ problem }: { problem: "conversations" | "deliveries" | "identity" | "participant" | "status" }) => ({
        conversations: "An Agent can read Channel conversations only when its operations() capability sets `conversations`.",
        deliveries: "An Agent can read Channel deliveries only when its operations() capability sets `conversations: \"all\"`.",
        identity: "The Actor has no identity that can be matched to the people of this thread.",
        participant: "The Actor is not a participant of this thread.",
        status: "An Agent can read Channel status only when its operations() capability sets `conversations: \"all\"`.",
      })[problem],
      fix: "Let the Agent read the threads that it takes part in with `operations({ conversations: \"participant\" })`, or every thread, the Channel status, and the deliveries with `operations({ conversations: \"all\" })`.",
    },
    AGENT_CHANNELS_HOST_UNAVAILABLE: {
      why: ({ detail, read }: { detail?: string, read: "admission" | "durable" | "host" | "participants" | "state" | "transcripts" }) => ({
        admission: `The thread admission could not be read from the Agent State: ${detail}`,
        durable: "This Channel requires durable State. Configure persistent SQLite/libSQL storage or Cloudflare Durable Objects.",
        host: "The Channel webhook routes of this app have not started in this process, or the Agent State cannot read conversations.",
        participants: `The transcript participants could not be read from the Agent State: ${detail}`,
        state: `The Agent State could not be read: ${detail}`,
        transcripts: `The transcripts could not be read from the Agent State: ${detail}`,
      })[read],
      fix: "Give the Agent a State that can read lists: libSQL with `VITEHUB_AGENT_STATE_URL` or `agent.providers.state`, or a Cloudflare Durable Object State (`agent.providers.state.driver: \"cloudflare\"`). The generated webhook route installs the reader when the server starts.",
    },
    AGENT_CHANNELS_NOT_FOUND: {
      why: ({ agent, channel, problem }: { agent?: string, channel?: string, problem: "agent" | "channel" | "history" | "unknown" }) => ({
        agent: `The app has no Agent named ${agent} with Channels.`,
        channel: `The Agent ${agent} has no Channel ${channel}.`,
        history: `Channel ${channel} has its own history collection and no per-thread conversation.`,
        unknown: `Unknown Channel ${channel}.`,
      })[problem],
      fix: "Run `vitehub channels list` to see the Agents and the Channels that keep conversations, and pass one of their names.",
    },
    AGENT_CHANNELS_NO_CONVERSATIONS: {
      why: ({ channel }: { channel: string }) => `Channel ${channel} has its own history collection and no per-thread conversation.`,
      fix: "Use `vitehub channels replay` to work with the history of this Channel.",
    },
    AGENT_CHANNELS_NO_STATUS: {
      why: ({ channel }: { channel: string }) => `Channel ${channel} has no sync status.`,
      fix: "Read the status of a Channel that reads a provider cursor, such as Gmail. Other Channels have no sync status.",
    },
    AGENT_CHANNELS_PROVIDER_FAILED: {
      why: ({ detail }: { detail: string }) => `The provider history could not be read: ${detail}`,
      fix: "Read `error.cause` for the provider error. Check the credentials of the Chat adapter of the Channel, then try again.",
    },
    AGENT_CHANNELS_THREAD_UNKNOWN: {
      why: ({ thread }: { thread: string }) => `The Channel has no Invocation and no transcript for the thread ${thread}.`,
      fix: "Run `vitehub channels threads <agent> <channel>` to see the threads of the Channel.",
    },
    AGENT_CHANNEL_ACTIVITY_UNSUPPORTED: {
      why: ({ channelId }: { channelId: string }) => `Agent channel ${channelId} does not support activity.`,
      fix: "Pass the id of a Channel that has an `activity` adapter to `publishAgentActivity({ channelId })`.",
    },
    AGENT_CHANNEL_DEFINITION_NOT_FOUND: {
      why: ({ agent, channel, channels }: { agent: string, channel: string, channels: string[] }) => `[vitehub] Agent ${agent} lists the Channel "${channel}", but server/channels has no Channel with that name. Channels: ${channels.join(", ") || "none"}.`,
      fix: "Correct the name in `defineAgent({ channels })` to one of the Channels that the message lists, or add the Channel as server/channels/<name>/index.ts.",
    },
    AGENT_CHANNEL_DELIVERY_CHANNEL_INVALID: {
      why: "[vitehub] channelDelivery({ channel }) requires a Channel client, for example useChannel(\"teams\").",
      fix: "Pass a Channel client with a `send()` method to `channelDelivery({ channel })`, such as `useChannel(\"teams\")`.",
    },
    AGENT_CHANNEL_DELIVERY_FORMAT_EMPTY: {
      why: ({ name }: { name: string }) => `[vitehub] ${name} requires formatted text to be non-empty.`,
      fix: "Return non-empty text from the `channelDelivery({ format })` function.",
    },
    AGENT_CHANNEL_DELIVERY_MAX_CALLS_INVALID: {
      why: "[vitehub] channelDelivery({ maxCalls }) must be a positive integer.",
      fix: "Set `channelDelivery({ maxCalls })` to an integer of 1 or more, or omit it to allow one call.",
    },
    AGENT_CHANNEL_DELIVERY_MESSAGE_MISSING: {
      why: ({ name }: { name: string }) => `[vitehub] ${name} requires a non-empty message.`,
      fix: "The model called the delivery tool that the message names without text. It reads this error and can call the tool again; if it does not, tell it in the Agent instructions to pass the text to send in `message`.",
    },
    AGENT_CHANNEL_DELIVERY_REMINDER_INSTRUCTION_INVALID: {
      why: "[vitehub] channelDelivery({ reminder: { instruction } }) must be a non-empty string.",
      fix: "Set `channelDelivery({ reminder: { instruction } })` to non-empty text, or omit it to use the default reminder.",
    },
    AGENT_CHANNEL_DELIVERY_REMINDER_NOT_REQUIRED: {
      why: "[vitehub] channelDelivery({ reminder }) requires required: true.",
      fix: "Add `required: true` to `channelDelivery({ reminder })`, or remove `reminder`.",
    },
    AGENT_CHANNEL_DELIVERY_REMINDER_TURNS_INVALID: {
      why: "[vitehub] channelDelivery({ reminder: { turns } }) must be a positive integer.",
      fix: "Set `channelDelivery({ reminder: { turns } })` to an integer of 1 or more.",
    },
    AGENT_CHANNEL_HOST_NAME_TAKEN: {
      why: ({ agent, channel }: { agent: string, channel: string }) => `[vitehub] Channel ${channel} serves its webhooks as "${agent}", which is also the name of an Agent Definition. Rename the Channel folder or the Agent.`,
      fix: "Rename the Agent that has the name `channel-<name>`, or rename the Channel folder under server/channels/.",
    },
    AGENT_CHANNEL_IMPORT_CYCLE: {
      why: ({ agent, channel }: { agent: string, channel: string }) => `[vitehub] Agent ${agent} lists the Channel "${channel}", whose static imports lead back to that Agent. Use a lazy task target, agent: () => import('...'), or leave the Channel unlisted. Named Channels cannot statically import their owning Agent.`,
      fix: "In the Channel file, load the Agent with a lazy task target, such as `tasks: { triage: { agent: () => import('../../agents/triage') } }`, or remove the Channel from `defineAgent({ channels })`.",
    },
    AGENT_CHANNEL_MESSAGE_ID_MISSING: {
      why: ({ label, root }: { label: string, root: boolean }) => root
        ? `[vitehub] ${label} did not return a root message ID, so replies cannot go under it.`
        : `[vitehub] ${label} posted this message without returning its ID, so it cannot be edited or deleted.`,
      fix: "Make the `postMessage()` and `postChannelMessage()` methods of the Chat adapter return the `id` of the message that the provider created. Edit or delete the original message in the chat client if needed.",
    },
    AGENT_CHANNEL_PULL_CURSOR_INVALID: {
      why: ({ key, cursor, next, kind }: { key: string, cursor: string | number, next: string | number | undefined, kind: "back" | "gap" | "repeated" | "stuck" }) => kind === "gap"
        ? `[vitehub] context.pull("${key}") has a gap: expected cursor ${cursor}, received ${next}.`
        : kind === "back"
          ? `[vitehub] context.pull("${key}") moved its cursor back from ${cursor} to ${next}.`
          : kind === "stuck"
            ? `[vitehub] context.pull("${key}") reported more items without advancing its cursor ${cursor}.`
            : `[vitehub] context.pull("${key}") repeated cursor ${next}.`,
      fix: "Make the `context.pull()` fetch function start each page at the given cursor, move `next` forward, and return `more: false` on the last page.",
    },
    AGENT_CHANNEL_PULL_CURSOR_TYPE_CHANGED: {
      why: ({ key, cursorType }: { key: string, cursorType: string }) => `[vitehub] The saved cursor of context.pull("${key}") is not a ${cursorType}.`,
      fix: "Keep `initialCursor` of `context.pull()` the same type as the saved cursor, or pass a new `key` to start a new cursor.",
    },
    AGENT_CHANNEL_PULL_OPTIONS_INVALID: {
      why: ({ key, need }: { key: string, need: "a fetch function" | "a non-empty key" | "a string or finite number initialCursor" | "the trigger that admits its items" }) => key ? `[vitehub] context.pull("${key}") needs ${need}.` : `[vitehub] context.pull() needs ${need}.`,
      fix: "Pass `key`, `initialCursor` (a string or a number), `fetch`, and `trigger` to `context.pull({ key, initialCursor, fetch, trigger })`.",
    },
    AGENT_CHANNEL_PULL_PAGE_INVALID: {
      why: ({ key, cursorType }: { key: string, cursorType: string }) => `[vitehub] context.pull("${key}") fetch must return { items, next, more } with a ${cursorType} next cursor.`,
      fix: "Return `{ items, next, more }` from the `context.pull()` fetch function, with `next` of the same type as `initialCursor`.",
    },
    AGENT_CHANNEL_PULL_STATE_MISSING: {
      why: ({ triggerId }: { triggerId: string }) => `[vitehub] Channel trigger "${triggerId}" can pull only with the Channel's State. Run it through the Channel's webhook route.`,
      fix: "Call `context.pull()` only in a trigger that runs from the Channel webhook route, where the Channel State is bound.",
    },
    AGENT_CHANNEL_SKIP_REPLY_REASON_MISSING: {
      why: ({ name }: { name: string }) => `[vitehub] ${name} requires a non-empty reason.`,
      fix: "The model called the skip reply tool that the message names without a reason. It reads this error and can call the tool again; if it does not, tell it in the Agent instructions to give a short `reason` when it skips a reply.",
    },
    AGENT_CHANNEL_STATE_DURATION_INVALID: {
      why: ({ name, allowZero }: { name: "ttlMs" | "waitMs", allowZero: boolean }) => `[vitehub] channelState.transaction() ${name} must be a ${allowZero ? "non-negative" : "positive"} finite number.`,
      fix: "Pass `ttlMs` as a number above 0 and `waitMs` as a number of 0 or more to `channelState.transaction(key, run, { ttlMs, waitMs })`.",
    },
    AGENT_CHANNEL_STATE_LOCK_BUSY: {
      why: ({ key, waitMs }: { key: string, waitMs: number }) => `[vitehub] Channel State lock "${key}" is still held after ${waitMs} ms.`,
      fix: "Retry later: a webhook delivery retries by itself. If the lock stays busy, raise `waitMs` of `channelState.transaction()` or make the work that holds the lock shorter.",
    },
    AGENT_CHANNEL_STATE_QUEUE_MISSING: {
      why: "[vitehub] Channel State writes with a delivery need a queue-capable State.",
      fix: "Use a queue-capable Agent State, such as `vitehub({ agent: { providers: { state: { driver: \"sqlite\" } } } })`, for Channels that queue deliveries.",
    },
    AGENT_CHANNEL_STATE_TRANSACTION_INVALID: {
      why: ({ need }: { need: "a callback" | "a non-empty key" }) => `[vitehub] channelState.transaction() needs ${need}.`,
      fix: "Call `channelState.transaction(key, run)` with a non-empty string key and a callback function.",
    },
    AGENT_CHANNEL_STATE_TRANSACTION_NESTED: {
      why: ({ key }: { key: string }) => `[vitehub] Channel State key "${key}" already has a transaction in this trigger call.`,
      fix: "Use one `channelState.transaction()` per key in a trigger call, and read and write that key inside its callback.",
    },
    AGENT_CHANNEL_TASK_HANDLED: {
      why: ({ task }: { task: string }) => `[vitehub] Channel task "${task}" did not resolve to an invocation.`,
      fix: "Make the queued Channel task that the message names start an Agent or a `run` function, and not answer with a `Response`.",
    },
    AGENT_CHANNEL_WEBHOOK_PATH_TAKEN: {
      why: ({ channel, path, target }: { channel: string, path: string, target: string }) => `[vitehub] Channel ${channel}: the webhook path ${JSON.stringify(path)} is already routed to ${JSON.stringify(target)}.`,
      fix: "Give each Channel its own webhook paths: change `path` or `aliases` in one of the two Channel adapters, or route the path explicitly in `vitehub({ agent: { routes: { aliases } } })`.",
    },
    AGENT_CHAT_RECOVERY_INDEX_CONFLICT: {
      why: ({ step }: { step: "acquire" | "commit" | "owner" }) => step === "acquire"
        ? "Could not acquire the interrupted chat index lock."
        : step === "commit"
          ? "Lost the interrupted chat index lock before committing."
          : "Interrupted chat recovery no longer owns this record.",
      fix: "Nothing to change when it happens once: another server instance recovers the same chat. If it repeats, check that the Agent State can take and keep locks.",
    },
    AGENT_CONFIGURED_OPTIONS_INVALID: {
      why: "[vitehub] A configured Agent requires only options defaults and a configure callback.",
      fix: "Pass only `options` (an object), `configure` (a function), and an optional `configKey` to `defineAgent({ options, configure })`.",
    },
    AGENT_CONFIGURE_RESULT_INVALID: {
      why: "[vitehub] Agent configure must return an Agent Definition created by defineAgent().",
      fix: "Return `defineAgent({ ... })` from the `configure` callback of `defineAgent({ options, configure })`.",
    },
    AGENT_CONFIG_KEY_INVALID: {
      why: "[vitehub] Agent configKey must be a non-reserved configuration key.",
      fix: "Set `configKey` in `defineAgent({ options, configure, configKey })` to a camelCase name that is not an Agent option, such as `\"babysitter\"`.",
    },
    AGENT_CONNECTOR_ADAPTER_UNSUPPORTED: {
      why: ({ label, action }: { label: string, action: "delete messages" | "open direct messages" | "post channel messages" }) => `[vitehub] The ${label} adapter cannot ${action}.`,
      fix: "Pass a Chat adapter that has the method that the message names, or send without `replace`, a `user:` recipient, or `thread`.",
    },
    AGENT_CONNECTOR_RECIPIENT_INVALID: {
      why: ({ label }: { label: "Slack" | "Teams" }) => `[vitehub] The ${label} recipient is not a ${label} thread ID.`,
      fix: "Pass a thread ID that the Chat adapter encodes as `recipient`, such as the `threadId` of a message that the Channel received.",
    },
    AGENT_CONNECTOR_RECIPIENT_MISSING: {
      why: ({ label }: { label: string }) => `[vitehub] ${label} send requires a recipient.`,
      fix: "Pass `recipient` to `send(message, { recipient })`, such as a channel thread ID or `user:<id>`.",
    },
    AGENT_CONNECTOR_REPLACE_INVALID: {
      why: ({ label }: { label: string }) => `[vitehub] ${label} replace requires the idempotency key of an earlier send and its own idempotencyKey.`,
      fix: "Pass `idempotencyKey` to `send()` and set `replace` to the `idempotencyKey` of an earlier send, not to the same key.",
    },
    AGENT_CONNECTOR_REPLACE_THREAD_ROOT: {
      why: ({ label }: { label: string }) => `[vitehub] ${label} replace cannot delete a channel thread root. Set thread.root on the first send so the temporary message is a reply.`,
      fix: "Set `thread.root` on the first `send()` of the thread, so the message that `replace` deletes is a reply and not the root.",
    },
    AGENT_CONNECTOR_THREAD_KEY_MISSING: {
      why: ({ label }: { label: string }) => `[vitehub] ${label} thread requires a non-empty key.`,
      fix: "Pass `thread: { key }` with a non-empty key to `send()`, or omit `thread`.",
    },
    AGENT_CONNECTOR_THREAD_RECIPIENT_INVALID: {
      why: ({ label }: { label: string }) => `[vitehub] A ${label} thread requires a channel recipient without a message ID.`,
      fix: "Pass the channel, not a message thread, as `recipient` when you send with `thread`.",
    },
    AGENT_CONNECTOR_THREAD_UNSUPPORTED: {
      why: ({ name }: { name: string }) => `[vitehub] The ${name}() Channel does not support thread in send().`,
      fix: "Remove `thread` from `send()` for this Channel. Only the `slack()` and `teams()` Channels support `thread`.",
    },
    AGENT_CONSOLE_DELIVERY_INCOMPLETE: {
      why: "Console delivery requires both url and token.",
      fix: "Pass both `url` and `token` to `createAgentConsoleDelivery({ url, token })`, or pass neither to turn Console delivery off.",
    },
    AGENT_CONSOLE_DELIVERY_URL_INVALID: {
      why: "Console delivery requires an HTTP(S) URL without embedded credentials.",
      fix: "Pass an `http:` or `https:` URL without a user name or password as `createAgentConsoleDelivery({ url })`, and pass the secret as `token`.",
    },
    AGENT_CONVERSATIONS_EXPORT_ARGUMENTS_INVALID: {
      why: ({ problem, value }: { problem: "argument" | "format" | "media" | "missing" | "option" | "value", value?: string }) => ({
        argument: `Unexpected argument ${value}.`,
        format: "--format must be markdown or json.",
        media: "--media needs --output <directory>, since attachments are files.",
        missing: "An agent, a channel, and a thread are required.",
        option: `Unknown option ${value}.`,
        value: `${value} requires a value.`,
      })[problem],
      fix: "Pass the Agent, the Channel, and the thread to `vitehub conversations export <agent> <channel> <thread>`, and only the options that `vitehub conversations export --help` lists. Add `--output <directory>` when you pass `--media`.",
    },
    AGENT_CONVERSATIONS_EXPORT_DEV_SERVER_MISSING: {
      why: ({ root }: { root: string }) => `No dev server is running for ${root}. Start \`vite dev\` or pass --url <origin>.`,
      fix: "Start `vite dev` in the app, or pass `--url <origin>` of a running app to `vitehub conversations export`.",
    },
    AGENT_CONVERSATIONS_EXPORT_OUTPUT_EXISTS: {
      why: ({ directory }: { directory: string }) => `The output directory already exists: ${directory}`,
      fix: "Pass a directory that does not exist to `--output`, or delete the directory that the message names.",
    },
    AGENT_CONVERSATIONS_EXPORT_PATH_UNSAFE: {
      why: ({ path }: { path: string }) => `The server named a file outside the output directory: ${path}.`,
      fix: "Pass `--url` the origin of your own ViteHub app, and use the same `@vite-hub/agent` version in the app and in the CLI. The CLI writes no file outside `--output`.",
    },
    AGENT_CUSTOM_INSTRUCTIONS_NOT_STRING: {
      why: "[vitehub] context.customInstructions must be a string.",
      fix: "Pass the custom instructions as a Markdown string in `context.customInstructions`, or omit the value.",
    },
    AGENT_CUSTOM_INSTRUCTIONS_REFERENCE_INVALID: {
      why: "[vitehub] context.customInstructions is available only through the authored {{{ context.customInstructions }}} slot.",
      fix: "Remove `data.context.customInstructions` bindings from the Agent instructions and write the exact `{{{ context.customInstructions }}}` slot instead.",
    },
    AGENT_CUSTOM_INSTRUCTIONS_SLOT_MISSING: {
      why: "[vitehub] context.customInstructions requires a {{{ context.customInstructions }}} slot outside code in the Agent instructions.",
      fix: "Add a `{{{ context.customInstructions }}}` line outside code blocks to the Agent instructions, or do not pass `context.customInstructions`.",
    },
    AGENT_DEFINITION_EXPORT_MISSING: {
      why: ({ file, name }: { file: string, name: string }) => `[vitehub] Agent "${name}" has no default export in ${file}. Every file that Agent discovery finds must export its Agent Definition as default.`,
      fix: "Export the Agent from the file with `export default defineAgent({ ... })`. If the file holds helpers and not an Agent, move it out of `server/agents/`, or set `agent: false` in `vitehub()` when the app has no Agents.",
    },
    AGENT_DISPATCH_DRY_RUN_WITH_QUEUE: {
      why: ({ channelId }: { channelId: string }) => `[vitehub] Channel "${channelId}" cannot combine dispatch dryRun with queue.`,
      fix: "Remove `dryRun` or `queue` from the `dispatch()` options. A queued dispatch cannot be a dry run.",
    },
    AGENT_DISPATCH_ITEMS_INVALID: {
      why: ({ channelId }: { channelId: string }) => `[vitehub] Channel "${channelId}" dispatch needs an array of items.`,
      fix: "Pass an array of items to `dispatch(items, { trigger })`.",
    },
    AGENT_DISPATCH_ITEM_KEY_MISSING: {
      why: ({ channelId }: { channelId: string }) => `[vitehub] Channel "${channelId}" dispatch items need a non-empty key.`,
      fix: "Give each item of `dispatch(items, { trigger })` a non-empty `key`, such as the provider's event ID.",
    },
    AGENT_DISPATCH_ITEM_ORDER_INVALID: {
      why: ({ channelId, key }: { channelId: string, key: string }) => `[vitehub] Channel "${channelId}" dispatch item "${key}" needs order { key, version } with a non-empty key and a finite number version.`,
      fix: "Set `order` of each dispatched item to `{ key, version }` with a non-empty key and a finite number, or omit `order`.",
    },
    AGENT_DISPATCH_ITEM_REJECTED: {
      why: ({ triggerId, key, status }: { triggerId: string, key: string, status: number }) => `[vitehub] Channel trigger "${triggerId}" rejected item "${key}" with HTTP ${status}.`,
      fix: "Check the trigger that the message names: it answered the item with an HTTP error. Make it admit the item, or leave the item out of `dispatch()`.",
    },
    AGENT_DISPATCH_QUEUE_OWNERSHIP_INVALID: {
      why: ({ triggerId }: { triggerId: string }) => `[vitehub] Queued dispatch needs webhook.deliveryId and webhook.concurrencyLimit (or serialize) from trigger "${triggerId}", without busy: "steer" or rehydrate.`,
      fix: "Return `webhook.deliveryId` and `webhook.concurrencyLimit` or `webhook.serialize` from the trigger, without `busy: \"steer\"` or `rehydrate`, when you dispatch with `queue: true`.",
    },
    AGENT_DRAIN_MS_INVALID: {
      why: "[vitehub] agent.shutdown.drainMs must be a finite number of milliseconds, 0 or more.",
      fix: "Set `vitehub({ agent: { shutdown: { drainMs } } })` to a number of milliseconds, 0 or more, such as `45_000`.",
    },
    AGENT_EXECUTION_BUDGET_AI_SDK_UNSUPPORTED: {
      why: "[vitehub] Execution budgets require AI SDK wrapLanguageModel support.",
      fix: "Upgrade the `ai` package to a version that exports `wrapLanguageModel`, or turn the execution budget off.",
    },
    AGENT_EXTENDS_INVALID: {
      why: "[vitehub] defineAgent({ extends }) requires an Agent Definition created by defineAgent().",
      fix: "Import the parent Agent Definition that `defineAgent()` returns and pass it to `defineAgent({ extends })`.",
    },
    AGENT_GITHUB_ACTIVITY_AGENT_MISSING: {
      why: "GitHub activity session links require an Agent identity.",
      fix: "Run the GitHub Channel from an Agent Definition so the activity has an Agent identity, or remove `activity.publicUrl` from the GitHub Channel options.",
    },
    AGENT_GMAIL_CERTIFICATES_FAILED: {
      why: ({ status }: { status: number }) => `Google OAuth certificates request failed with HTTP ${status}.`,
      fix: "Check that the server can reach https://www.googleapis.com/oauth2/v3/certs. A retry helps when Google was only unavailable.",
    },
    AGENT_GMAIL_DISPATCH_FAILED: {
      why: ({ count }: { count: number }) => `Gmail message dispatch failed for ${count} message(s); saved for retry.`,
      fix: "Read the failed Invocations of the Gmail Channel for the cause. The messages are saved, and the next poll retries them.",
    },
    AGENT_GMAIL_LOCK_LOST: {
      why: ({ lock }: { lock: "mailbox" | "skipped messages" }) => lock === "mailbox" ? "Lost ownership of the Gmail mailbox lease." : "Lost the lock of the Gmail skipped messages.",
      fix: "Poll the Gmail Channel again. Another process took the lock after it expired, which a slow Agent State can cause.",
    },
    AGENT_GMAIL_MAILBOX_MISMATCH: {
      why: "Gmail notification belongs to another mailbox.",
      fix: "Point the Pub/Sub push subscription of this Gmail Channel only at the mailbox of its refresh token.",
    },
    AGENT_GMAIL_OAUTH_REFRESH_FAILED: {
      why: ({ detail, status }: { detail?: string, status: number }) => status ? `Google OAuth token refresh failed with HTTP ${status}${detail ? `: ${detail}` : ""}.` : `Google OAuth token refresh failed: ${detail}`,
      fix: "Check the Gmail OAuth client ID, client secret, and refresh token in Server Env `gmail`, and that Google has not revoked the refresh token. Without an HTTP status, read `error.cause` for the network failure and try again.",
    },
    AGENT_GMAIL_REQUEST_FAILED: {
      why: ({ reason, request, status }: { reason?: string, request: string, status: number }) => `${request} failed with HTTP ${status}${reason ? `: ${reason}` : ""}.`,
      fix: "Read the HTTP status and the Google error in the message. For 401 or 403, check the Gmail OAuth client, refresh token, and scopes in Server Env `gmail`. For 429 or a 5xx status, try again later.",
    },
    AGENT_GMAIL_SYNC_BUSY: {
      why: "Gmail mailbox synchronization is already running; retry polling after it completes.",
      fix: "Poll the Gmail Channel again after the running synchronization completes.",
    },
    AGENT_GMAIL_TOKEN_REFRESH_FAILED: {
      why: ({ reason, status }: { reason?: string, status?: number }) => `Google OAuth token refresh failed${status ? ` with HTTP ${status}` : ""}${reason ? `: ${reason}` : ""}.`,
      fix: "Check GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN, and create a new refresh token when Google answers `invalid_grant`. Read error.cause for a network failure.",
    },
    AGENT_HOST_ROUTE_DUPLICATE: {
      why: ({ route }: { route: string }) => `Agent host route already registered: ${route}`,
      fix: "Pass a `route` to `agentHostRoutes({ health, workspace })` that no other Nitro handler uses.",
    },
    AGENT_HOST_ROUTE_EXPORT_NAME_INVALID: {
      why: "Agent host route exportName must be a JavaScript identifier.",
      fix: "Set `exportName` in `agentHostRoutes({ health, workspace })` to the name of an export of the entry file, such as `\"inspectHealth\"`.",
    },
    AGENT_HOST_ROUTE_PATH_INVALID: {
      why: "Agent host routes require an absolute path without query, hash, or wildcard; Workspace routes require an :id parameter.",
      fix: "Set `route` in `agentHostRoutes()` to a path that starts with `/` and has no `?`, `#`, or `*`. A Workspace route also needs an `:id` segment.",
    },
    AGENT_INLINE_INVOCATION_WORKFLOW: {
      why: ({ capabilities }: { capabilities: boolean }) => capabilities
        ? "[vitehub] Invocation capabilities cannot be used with an explicit Agent Workflow. They require inline execution."
        : "[vitehub] Invocation tools cannot be used with an explicit Agent Workflow. Callable tools require inline execution.",
      fix: "Remove `tools` and `capabilities` from the `runAgent()` options, or run an Agent that has no explicit Workflow.",
    },
    AGENT_INSTRUCTIONS_EXTEND_INVALID: {
      why: "[vitehub] driver.instructions extend() must return a string.",
      fix: "Return the instructions text as a string from the `driver.instructions` `extend()` function.",
    },
    AGENT_INSTRUCTION_SLOT_INVALID: {
      why: "[vitehub] Instruction templates require exactly one {{{ instructions }}} slot outside code.",
      fix: "Write exactly one `{{{ instructions }}}` slot outside code blocks in the `driver.instructions.template` text.",
    },
    AGENT_INVOCATIONS_DATABASE_DRIVER_UNSUPPORTED: {
      why: ({ need }: { need: "a D1 batch driver that returns results" | "a D1 batch driver that returns rows" | "a SQLite batch driver that returns rows" | "a driver that returns named columns. The Cloudflare D1 HTTP driver is not supported" }) => `[vitehub] Database Agent Invocations require ${need}.`,
      fix: "Keep Agent Invocations on a Database that uses the D1 binding or SQLite, not D1 over `cloudflare.http`.",
    },
    AGENT_INVOCATIONS_DATABASE_WITHOUT_STORE: {
      why: "[vitehub] Agent invocations accept `database` only with `store: \"database\"`.",
      fix: "Set `store: \"database\"` next to `database` in the Agent `invocations` option, or remove `database`.",
    },
    AGENT_INVOCATION_CLAIM_CONFLICT: {
      why: "Invocation already exists or is claimed.",
      fix: "Another run already holds this Invocation, so this duplicate does not run. Read it with `invocations.get(id)`, or pass `force` to Channel replay to start it again.",
    },
    AGENT_INVOCATION_CLAIM_UNAVAILABLE: {
      why: "Could not acquire the Invocation execution claim.",
      fix: "Check that the Invocations store of the Agent is reachable and can write, then retry the Invocation.",
    },
    AGENT_INVOCATION_ID_AMBIGUOUS: {
      why: "The ID matches multiple Agent invocation journals. Cancel through the intended Agent's invocations.cancel(id).",
      fix: "Cancel the Invocation through the Agent that owns it, with `invocations.cancel(id)` of that Agent.",
    },
    AGENT_INVOCATION_STORE_TIMEOUT: {
      why: ({ step, ms }: { step: "store open" | "store operation" | "cancellation store operation", ms: number }) => `[vitehub] Agent Invocation ${step} timed out after ${ms} ms.`,
      fix: "Check that the Invocations store in `defineAgentInvocations({ store })` is reachable and answers in time. A retry helps when the store was only slow.",
    },
    AGENT_INVOCATION_STORE_UNCONFIRMED: {
      why: ({ step }: { step: "confirm the accepted Workflow Invocation" | "confirm the Workflow Invocation dispatch" | "confirm the Workflow Invocation handoff" | "persist the claimed Invocation run metadata" | "persist the Invocation running state" | "persist the Workflow dispatch intent" | "transfer the Invocation execution claim" }) => `Could not ${step}.`,
      fix: "Check that the Invocations store of the Agent is reachable and can write, then retry the Invocation. Strict enforcement and Channel replay wait for the store to confirm each step.",
    },
    AGENT_INVOCATION_TOOL_NAME_TAKEN: {
      why: ({ names }: { names: string[] }) => `[vitehub] Invocation tool name already exists: ${names.join(", ")}.`,
      fix: "Rename the tools in `runAgent({ tools })` so that no name matches a tool of the Agent's Capabilities.",
    },
    AGENT_MAX_RETRIES_INVALID: {
      why: "maxRetries must be a non-negative integer",
      fix: "Set `maxRetries` of the model call settings to an integer of 0 or more.",
    },
    AGENT_MCP_BEARER_TOKEN_RENAMED: {
      why: "[vitehub] driver.env sets T3_MCP_BEARER_TOKEN. Codex now reads the token of the ViteHub tools MCP server from VITEHUB_MCP_BEARER_TOKEN, so the old variable has no effect.",
      fix: "Remove `T3_MCP_BEARER_TOKEN` from `driver.env`. ViteHub sets `VITEHUB_MCP_BEARER_TOKEN`. Update any `launch` wrapper that hard-codes the old name to forward the new one. A wrapper that forwards `requiredEnvironment` needs no change.",
    },
    AGENT_MCP_RETRIES_INVALID: {
      why: "[vitehub] callMcpTool({ retries }) must be a non-negative integer.",
      fix: "Set `retries` in the `callMcpTool()` options to an integer of 0 or more.",
    },
    AGENT_MCP_TOOLS_LIST_INVALID: {
      why: "[vitehub] MCP tools/list must return a tools array.",
      fix: "Check that the MCP server answers `tools/list` with a `tools` array, and update the server if it does not.",
    },
    AGENT_MEMORY_EVENT_INVALID: {
      why: ({ issues, line, path }: { issues: string, line: number, path: string }) => `[vitehub] Line ${path}:${line} of the workspaceJsonlMemoryStore() file is JSON, but not a memory event: ${issues}`,
      fix: "Fix or remove that line. The memory tools write each line as an upsert, supersede, or delete event, so do not edit the file by hand or with another tool.",
    },
    AGENT_NAME_DUPLICATE: {
      why: ({ name }: { name: string }) => `[vitehub] Duplicate Agent name "${name}" discovered.`,
      fix: "Rename one of the Agent files so that each Agent has its own name, such as `server/agents/<name>/agent.ts`.",
    },
    AGENT_OBSERVABILITY_INSTALLED: {
      why: "[vitehub] Observability is already installed. Close its host before installing another instance.",
      fix: "Install observability once per server through `vitehub({ observability })`, and close the old host before you install it again.",
    },
    AGENT_OBSERVABILITY_MAX_PENDING_INVALID: {
      why: "[vitehub] evlog maxPending must be a positive integer.",
      fix: "Set `vitehub({ observability: { maxPending } })` to an integer of 1 or more.",
    },
    AGENT_OPENAPI_CONNECTION_BODY_INVALID: {
      why: "[vitehub] OpenAPI requests through a Connection require a string body. Serialize the request hook body before dispatch.",
      fix: "Return a string body from the OpenAPI request hook, such as `JSON.stringify(body)`, when the request goes through a Connection.",
    },
    AGENT_PAPERCUTS_BACKEND_MISSING: {
      why: "[vitehub] papercuts() requires a report callback or backend.",
      fix: "Pass `report` or `backend` to `papercuts()`, such as `papercuts({ backend: posthogPapercuts({ apiKey }) })`.",
    },
    AGENT_PAPERCUTS_CLI_INVALID: {
      why: "[vitehub] papercuts({ cli }) must be a boolean.",
      fix: "Set `papercuts({ cli })` to `true` or `false`, or omit it.",
    },
    AGENT_PAPERCUTS_DEDUPE_INVALID: {
      why: "[vitehub] papercuts({ dedupe }) must be a boolean or a papercut index.",
      fix: "Set `papercuts({ dedupe })` to `true`, `false`, or an index from `createPapercutIndex()`.",
    },
    AGENT_PAPERCUT_DELIVERY_INVALID: {
      why: "[vitehub] Invalid papercut delivery envelope.",
      fix: "Pass a papercut report event, or a delivery that `createPapercutDelivery()` returns, to the reporter `report()`.",
    },
    AGENT_PAPERCUT_IDENTITY_MISSING: {
      why: "[vitehub] Papercut reporting requires a persistent invocation identity.",
      fix: "Report papercuts from an Agent run that has a run ID and an Agent name, such as through the `report_papercut` tool.",
    },
    AGENT_PAPERCUT_INDEX_OPTION_INVALID: {
      why: ({ name }: { name: "maxEntries" | "windowMs" }) => `[vitehub] createPapercutIndex({ ${name} }) must be a positive number.`,
      fix: "Set `windowMs` and `maxEntries` of `createPapercutIndex()` to numbers above 0, or omit them.",
    },
    AGENT_PAPERCUT_INDEX_SIMILARITY_INVALID: {
      why: "[vitehub] createPapercutIndex({ similarity }) must be greater than 0 and at most 1.",
      fix: "Set `createPapercutIndex({ similarity })` to a number above 0 and at most 1, such as `0.4`.",
    },
    AGENT_PAPERCUT_INVALID: {
      why: "[vitehub] A papercut requires an ID, timestamp and message of 1–1000 characters.",
      fix: "Give the papercut an `id`, a `createdAt` timestamp, and a `message` of 1 to 1000 characters.",
    },
    AGENT_PAPERCUT_MESSAGE_MISSING: {
      why: "[vitehub] report_papercut requires a non-empty message.",
      fix: "Pass a short text that describes the papercut as `message` to the `report_papercut` tool. The model reads this error and can call the tool again.",
    },
    AGENT_PAPERCUT_MESSAGE_TOO_LONG: {
      why: ({ max }: { max: number }) => `[vitehub] report_papercut message must be at most ${max} characters.`,
      fix: "Shorten the `message` of the `report_papercut` tool to 1000 characters or less. The model reads this error and can call the tool again.",
    },
    AGENT_PAPERCUT_NOT_PERSISTED: {
      why: ({ step }: { step: "acknowledgement" | "report" }) => step === "acknowledgement"
        ? "[vitehub] Papercut delivery acknowledgement was not persisted."
        : "[vitehub] Papercut must be persisted before delivery.",
      fix: "Check that the Invocations store of the Agent is reachable and can write. The reporter retries pending papercuts on its next replay.",
    },
    AGENT_PAPERCUT_REPORTER_CLOSED: {
      why: "[vitehub] Papercut reporter is closed.",
      fix: "Create a new reporter with `createPapercutReporter()` after `stop()`. A stopped reporter cannot start again.",
    },
    AGENT_POSTHOG_API_KEY_MISSING: {
      why: "[vitehub] PostHog requires an API key.",
      fix: "Pass the project API key to `posthog({ apiKey })`, such as `process.env.POSTHOG_API_KEY`.",
    },
    AGENT_POSTHOG_DELIVERY_UNACKNOWLEDGED: {
      why: "[vitehub] PostHog did not acknowledge event delivery.",
      fix: "Check that the `posthog({ apiKey, host })` key and host are right and that PostHog is reachable. The exporter already retried rate limits and server errors.",
    },
    AGENT_POSTHOG_HOST_INVALID: {
      why: "[vitehub] PostHog requires an HTTP(S) host.",
      fix: "Set `posthog({ host })` to an `https:` or `http:` URL, such as `\"https://eu.i.posthog.com\"`, or omit it.",
    },
    AGENT_POSTHOG_PAPERCUTS_API_KEY_MISSING: {
      why: "[vitehub] posthogPapercuts() requires an apiKey.",
      fix: "Pass the PostHog API key to `posthogPapercuts({ apiKey })`, such as `process.env.POSTHOG_API_KEY`.",
    },
    AGENT_POSTHOG_PAPERCUT_DELIVERY_FAILED: {
      why: ({ status }: { status: number }) => `[vitehub] PostHog papercut delivery failed (${status}).`,
      fix: "Check the `posthogPapercuts({ apiKey, host })` key and host for the HTTP status in the message.",
    },
    AGENT_PRESET_OPTIONS_CONFLICT: {
      why: "[vitehub] Select preset options with options or a named block/tuple, not both.",
      fix: "Pass the preset options once: in `options`, in the preset's named block, or in the `extends` tuple.",
    },
    AGENT_PRESET_OPTIONS_INVALID: {
      why: ({ name }: { name: string }) => `[vitehub] Agent ${name} options must be an object.`,
      fix: "Pass an object as the preset options in `defineAgent({ extends, options })` or in the preset's named block.",
    },
    AGENT_PRESET_OPTIONS_WITHOUT_CONFIGURE: {
      why: "[vitehub] Agent options require a preset with options and configure.",
      fix: "Remove `options` from `defineAgent()`, or extend a preset that `defineAgent({ options, configure })` creates.",
    },
    AGENT_PRESET_OPTION_UNSUPPORTED: {
      why: "[vitehub] defineAgent() has no preset or presets option. Pass the parent Agent Definition as extends, such as defineAgent({ extends: babysitter }).",
      fix: "Replace `preset` or `presets` with `extends` and pass the imported Agent Definition, such as `defineAgent({ extends: babysitter })`.",
    },
    AGENT_PRESET_UNKNOWN: {
      why: ({ name }: { name: string }) => `[vitehub] Unknown Agent preset "${name}". Import the preset definition and pass it to extends.`,
      fix: "Import the preset Agent Definition and pass it to `defineAgent({ extends })` instead of its name.",
    },
    AGENT_PROCESS_HOST_DRAIN_ROUTE_INVALID: {
      why: "Process host drainRoute must be an absolute route without query, hash, or wildcard.",
      fix: "Set `processAgentHost({ drainRoute })` to a path that starts with `/` and has no `?`, `#`, or `*`, such as `\"/api/drain\"`.",
    },
    AGENT_PROCESS_HOST_EXPORT_NAME_INVALID: {
      why: "Process host exportName must be a JavaScript identifier.",
      fix: "Set `processAgentHost({ exportName })` to the name of an export of the entry file, or omit it to use the default export.",
    },
    AGENT_PROCESS_HOST_ROUTE_DUPLICATE: {
      why: ({ route }: { route: string }) => `Process host route already registered: ${route}`,
      fix: "Pass a `drainRoute` to `processAgentHost()` that no other Nitro handler uses.",
    },
    AGENT_PROVIDER_CHECKOUT_HEAD_CHANGED: {
      why: "Host-prepared provider checkout HEAD changed during launch.",
      fix: "Run the Agent again. Another process changed the pull request checkout while the provider started.",
    },
    AGENT_PROVIDER_FILES_CONFLICTED: {
      why: ({ files }: { files: string[] }) => `Cannot overwrite conflicted generated provider files: ${files.join(", ")}`,
      fix: "Resolve the merge conflict of the files that the message names in the pull request checkout, then run the Agent again.",
    },
    AGENT_QUEUED_INPUT_NOT_JSON: {
      why: ({ triggerId }: { triggerId: string }) => `[vitehub] Queued invocation through trigger "${triggerId}" needs JSON-serializable invocation input and run metadata.`,
      fix: "Pass only JSON values, without functions, class instances, or `undefined` in arrays, in the input and run metadata of a queued trigger invocation.",
    },
    AGENT_QUEUED_TASK_AGENT_CHANGED: {
      why: ({ task, triggerId }: { task: string, triggerId: string }) => `[vitehub] Queued task "${task}" of trigger "${triggerId}" no longer runs the Agent it was accepted for.`,
      fix: "Keep the Agent of a trigger task the same while queued deliveries wait, or let them finish before you deploy the change.",
    },
    AGENT_REPLAY_TASK_OTHER_AGENT: {
      why: ({ task }: { task: string | undefined }) => `Task "${task}" runs another Agent. Replay and dispatch() run tasks with run, or tasks of the replaying Agent; send this item through the Channel's webhook queue.`,
      fix: "Send the item through the Channel webhook queue, or make the Channel trigger select a task of the replaying Agent.",
    },
    AGENT_ROUTE_NOT_STATIC: {
      why: ({ label }: { label: string }) => `[vitehub] Agent ${label} requires a static route path.`,
      fix: "Use a fixed path without `:name`, `[name]`, `*`, `?`, or `#`, such as `/hooks/github`, as each key of `vitehub({ agent: { routes: { aliases } } })`.",
    },
    AGENT_SKILL_NAME_INVALID: {
      why: ({ name }: { name: string }) => `[vitehub] Invalid Skill name "${name}". Use letters, digits, ".", "_", or "-".`,
      fix: "Name each Skill in `agentWithSkills(agent, skills)` with letters, digits, `.`, `_`, or `-`.",
    },
    AGENT_SLACK_CONNECTOR_ADAPTER_MISSING: {
      why: "[vitehub] Sending with slack() requires an adapter, such as createSlackAdapter() from @chat-adapter/slack.",
      fix: "Pass the Slack adapter of the app to `slack({ adapter })`, such as `slack({ adapter: createSlackAdapter() })`.",
    },
    AGENT_STATE_ATOMIC_LOCK_MISSING: {
      why: "[vitehub] This operation requires State with atomic lease-fenced cache mutations (mutateWithLock).",
      fix: "Use an Agent State provider that has `mutateWithLock()`, such as SQLite, libSQL, or the Cloudflare State.",
    },
    AGENT_STATE_LOCK_EXPIRED: {
      why: ({ key }: { key: string }) => `[vitehub] Channel State lock "${key}" expired before its writes were committed.`,
      fix: "The webhook delivery retries by itself. If it repeats, make the trigger work that holds the Channel State lock shorter than its `ttlMs`.",
    },
    AGENT_STORAGE_PREFIX_INVALID: {
      why: ({ capability, prefix }: { capability: string, prefix: unknown }) => `[vitehub] ${capability}() prefix must name a non-empty key or path without "." or ".." segments, but it is ${JSON.stringify(prefix)}.`,
      fix: 'Pass a prefix such as "support:" for kv() or "reports/" for blob(), or remove the option to give the Agent the whole store.',
    },
    AGENT_STORAGE_PREFIX_OUTSIDE: {
      why: ({ label, prefix, value }: { label: string, prefix: string, value: string }) => `[vitehub] ${label} ${JSON.stringify(value)} is outside the prefix ${JSON.stringify(prefix)} that this Capability allows.`,
      fix: "Use a key or pathname that starts with the Capability prefix. To give the Agent more of the store, change the prefix option of the Capability.",
    },
    AGENT_TASK_AGENT_NAME_MISSING: {
      why: ({ task, triggerId }: { task?: string, triggerId?: string }) => task
        ? `[vitehub] Task "${task}" of trigger "${triggerId}" needs an Agent with a stable non-empty name. The webhook queue stores the name with the delivery.`
        : "[vitehub] A task Agent needs a stable non-empty name.",
      fix: "Point the task `agent` at an Agent Definition with a non-empty `name`, such as `defineAgent({ name: \"reviewer\" })` or an Agent file in `server/agents/`.",
    },
    AGENT_TELEMETRY_QUEUE_FULL: {
      why: "[vitehub] Agent telemetry queue is full.",
      fix: "Raise `vitehub({ observability: { maxPending } })`, or check that the exporter answers in time. The event is dropped.",
    },
    AGENT_TELEMETRY_UNAVAILABLE: {
      why: "[vitehub] Agent telemetry delivery is unavailable.",
      fix: "Configure an exporter in `vitehub({ observability })`, and capture events before the server closes.",
    },
    AGENT_TIMER_DURATION_INVALID: {
      why: ({ option }: { option: "Papercut deliveryTimeoutMs" | "Papercut replay interval" | "evlog deliveryTimeoutMs" }) => `[vitehub] ${option} must be a positive timer duration.`,
      fix: "Set the option that the message names to a whole number of milliseconds from 1 to 2147483647, or omit it to use the default.",
    },
    AGENT_TOOL_SCHEMA_ASYNC_VALIBOT: {
      why: "[vitehub] Async Valibot Agent tool schemas cannot be converted to JSON Schema.",
      fix: "Use a synchronous Valibot schema or a JSON Schema as the tool `inputSchema`.",
    },
    AGENT_TRIGGER_PREPARE_INVALID: {
      why: ({ triggerId }: { triggerId: string }) => `[vitehub] Trigger "${triggerId}" prepare must be a function.`,
      fix: "Set `prepare` of the trigger to a function, or remove it.",
    },
    AGENT_TRIGGER_SERIALIZE_CONFLICT: {
      why: ({ triggerId }: { triggerId: string }) => `[vitehub] Trigger "${triggerId}" webhook.serialize replaces concurrencyKey and concurrencyLimit. Set only one of them.`,
      fix: "Return either `webhook.serialize` or `webhook.concurrencyKey` with `webhook.concurrencyLimit` from the trigger, not both.",
    },
    AGENT_TRIGGER_SERIALIZE_INVALID: {
      why: ({ triggerId }: { triggerId: string }) => `[vitehub] Trigger "${triggerId}" webhook.serialize must be a non-empty string.`,
      fix: "Set `webhook.serialize` in the trigger result to a non-empty key, such as the conversation ID, or omit it.",
    },
    AGENT_TRIGGER_TASKS_INVALID: {
      why: ({ triggerId }: { triggerId: string }) => `[vitehub] Trigger "${triggerId}" tasks must be an object of named tasks.`,
      fix: "Set `tasks` of the trigger to an object whose keys are task names, such as `{ review: { agent } }`.",
    },
    AGENT_TRIGGER_TASK_INVALID: {
      why: ({ task, triggerId, problem }: { task: string, triggerId: string, problem: "failed must be a function." | "must be an object." | "must declare exactly one of agent or run." | "prepare must be a function." | "run must be a function." }) => `[vitehub] Task "${task}" of trigger "${triggerId}" ${problem}`,
      fix: "Declare each task in the trigger `tasks` as an object with exactly one of `agent` or `run`, and give `run`, `prepare`, and `failed` function values.",
    },
    AGENT_TRIGGER_TASK_UNKNOWN: {
      why: ({ task, triggerId }: { task: string, triggerId: string }) => `[vitehub] Task "${task}" is not declared by trigger "${triggerId}".`,
      fix: "Select a task that the trigger declares in `tasks`, or add the task to `tasks`. Keep a removed task while queued deliveries still name it.",
    },
    AGENT_UI_STREAM_MISSING: {
      why: "[vitehub] The Agent did not return a UI message stream.",
      fix: "Return a `ReadableStream`, an async iterable, or a `Response` from the Driver `run()` when you request the `ui-message-stream` output.",
    },
    AGENT_WEBHOOK_ALIAS_TARGET_INVALID: {
      why: "[vitehub] Webhook aliases require an Agent name and webhook name.",
      fix: "Give each entry of `vitehub({ agent: { routes: { aliases } } })` a non-empty `agent` and `webhook`, such as `{ \"/hooks/github\": { agent: \"triage\", webhook: \"github\" } }`.",
    },
    AGENT_WEBHOOK_FENCE_UNAVAILABLE: {
      why: ({ deliveryId }: { deliveryId: string }) => `[vitehub] Webhook delivery "${deliveryId}" could not acquire its concurrency fence.`,
      fix: "The webhook queue retries the delivery by itself. If it repeats, check that the Agent State can take locks.",
    },
    AGENT_WEBHOOK_HANDLED_RETRY: {
      why: ({ phase, status, reason }: { phase: "delivery" | "rehydration", status: number, reason: string | undefined }) => `[vitehub] Handled webhook ${phase} returned HTTP ${status}${reason ? ` (${reason})` : ""}.`,
      fix: "The webhook queue retries the delivery. Check the trigger handler that answered with 5xx, and answer with 2xx or 4xx to stop the retries.",
    },
    AGENT_WEBHOOK_REHYDRATION_CHANGED: {
      why: ({ kind, resolved, expected }: { kind: "Agent" | "task", resolved: string, expected: string }) => `[vitehub] Persisted webhook delivery resolved ${kind} "${resolved}" instead of "${expected}".`,
      fix: "Keep the task and Agent that a trigger selects for a delivery the same while queued deliveries wait, or let them finish before you deploy the change.",
    },
    AGENT_WEBHOOK_ROUTE_HOST_UNSUPPORTED: {
      why: ({ channel }: { channel?: string }) => channel === undefined
        ? "[vitehub] Webhook aliases currently require a Nitro host."
        : `[vitehub] Channel ${channel} declares its own webhook route. Inbound Channels that no Agent lists currently require a Nitro host.`,
      fix: "Build for a Nitro host, such as `vitehub({ host: \"node\" })`. On Deno or Netlify, remove `routes.aliases` from `vitehub({ agent })` and list each inbound Channel in `defineAgent({ channels })`.",
    },
    AGENT_WEBHOOK_STATE_SCOPE_INVALID: {
      why: ({ id }: { id: string }) => `[vitehub] Webhook registration "${id}" stateScope must be a non-empty string.`,
      fix: "Set `stateScope` of the webhook registration to a non-empty string, or omit it.",
    },
    AGENT_WORKFLOW_REPLAY_UNSAFE: {
      why: ({ reason }: { reason: "The acknowledged Workflow run is unavailable" | "Workflow dispatch acknowledgement is unknown" | "Workflow dispatch identity changed" }) => `${reason}; replay cannot safely submit this Invocation again.`,
      fix: "Find the Workflow run of this Invocation in the Workflow provider and finish or cancel it there. A replay does not help; keep the Workflow provider and Agent name unchanged while runs are pending.",
    },
    AGENT_WORKSPACE_COMMAND_CWD_OUTSIDE: {
      why: "[vitehub] Workspace command cwd must stay inside the provider checkout.",
      fix: "Pass a `cwd` inside `/workspace` to the Workspace command, or omit it to run at the checkout root.",
    },
    AGENT_WORKSPACE_GIT_INIT_FAILED: {
      why: "Unable to initialize workspace Git repository",
      fix: "Check that `git` is installed in the Workspace runtime and that the Workspace root can be written.",
    },
    // Channel and Invocation errors. They replace AGENT_R0930, AGENT_R0931, AGENT_R0940, AGENT_R0946, and AGENT_R1025, one code for each cause. Keep these codes in alphabetical order.
    AGENT_CHANNEL_HISTORY_INVALID: {
      why: ({ kind, detail }: { kind: string, detail: string }) => `[vitehub] channelAdapter("${kind}", { history }) ${detail}`,
      fix: "Pass `history` in `channelAdapter(kind, { history })` as `{ collection, key }` with a Collection from `defineCollection()`, and set `history.trigger` to a trigger of the Channel when it has more than one.",
    },
    AGENT_CHANNEL_HISTORY_MISSING: {
      why: ({ channel }: { channel: string }) => `[vitehub] Channel "${channel}" has no history. Add history to its defineChannel() or channelAdapter() options.`,
      fix: "Add `history` to the `defineChannel()` or `channelAdapter()` options of the Channel, or replay a Channel that has it.",
    },
    AGENT_CHANNEL_HISTORY_TRIGGER_UNKNOWN: {
      why: ({ channel, triggers }: { channel: string, triggers: string }) => `[vitehub] Channel "${channel}" history trigger must name one of the Channel triggers: ${triggers}.`,
      fix: "Set `history.trigger` of the Channel to the name of one of its triggers.",
    },
    AGENT_CHANNEL_MESSAGE_INVALID: {
      why: ({ kind, option }: { kind: string, option: "message" | "message: { methods }" }) => `[vitehub] channelAdapter("${kind}", { ${option} }) expects an object.`,
      fix: "Pass `message` in `channelAdapter(kind, { message })` as an object, and `message.methods` as an object of functions.",
    },
    AGENT_CHANNEL_MESSAGE_METHOD_INVALID: {
      why: ({ kind, name }: { kind: string, name: string }) => `[vitehub] Channel "${kind}" message method "${name}" must be a function or { read: true, handler }.`,
      fix: "Give each entry of `message.methods` in `channelAdapter(kind, { message })` a function or `{ read: true, handler }`.",
    },
    AGENT_CHANNEL_NOT_FOUND: {
      why: ({ channel }: { channel: string }) => `[vitehub] Agent has no Channel "${channel}".`,
      fix: "Pass the name of a Channel that the Agent uses, and check the spelling of the name in the message.",
    },
    AGENT_CHANNEL_ON_ADAPTER_UNSUPPORTED: {
      why: ({ kind }: { kind: string }) => `[vitehub] The \`on\` handlers of a "${kind}" Channel need an adapter that receives webhooks, such as webhook() or stripe().`,
      fix: "Set `defineChannel({ adapter })` to an adapter that receives webhooks, such as `webhook()` or `stripe()`, or remove the `on` handlers.",
    },
    AGENT_CHANNEL_ON_TRIGGER_NAME_TAKEN: {
      why: ({ name }: { name: string }) => `[vitehub] "${name}" is the trigger that runs the \`on\` handlers. Give the "${name}" trigger another name.`,
      fix: "Rename the Channel trigger that the message names.",
    },
    AGENT_CHANNEL_ON_WEBHOOK_TRIGGER: {
      why: ({ kind, trigger }: { kind: string, trigger: string }) => `[vitehub] The \`on\` handlers of the "${kind}" Channel receive its webhook, so the trigger "${trigger}" cannot. Set \`webhooks: []\` on it to run it only through dispatch, pull, or sendChannelTrigger().`,
      fix: "Set `webhooks: []` on the trigger that the message names, or make it an `on` handler.",
    },
    AGENT_CHANNEL_STATE_QUEUE_UNSUPPORTED: {
      why: ({ channel, action }: { channel: string, action: "cancel queued tasks" | "queue tasks" | "queue triggers" }) => `[vitehub] Channel "${channel}" State cannot ${action}. Use durable SQLite or libSQL Agent State.`,
      fix: "Give the Agent durable SQLite or libSQL Agent State, for example a libSQL database in VITEHUB_AGENT_STATE_URL.",
    },
    AGENT_CHANNEL_TASK_AGENT_AMBIGUOUS: {
      why: ({ channel, agents }: { channel: string, agents: string }) => `[vitehub] Channel "${channel}" is served by more than one Agent (${agents}). Give the Channel one Agent.`,
      fix: "Use the Channel that the message names in one Agent only.",
    },
    AGENT_CHANNEL_TASK_DELAY_INVALID: {
      why: "[vitehub] enqueueChannelTask() delayMs must be a non-negative integer.",
      fix: "Pass `delayMs` to `enqueueChannelTask()` as a whole number of milliseconds, 0 or more.",
    },
    AGENT_CHANNEL_TASK_KEY_INVALID: {
      why: ({ method }: { method: "cancelChannelTask" | "enqueueChannelTask" }) => method === "enqueueChannelTask"
        ? "[vitehub] enqueueChannelTask() key must be a non-empty string."
        : "[vitehub] cancelChannelTask() needs the non-empty key that the task was enqueued with.",
      fix: "Pass `key` as a non-empty string, and pass `cancelChannelTask()` the key that `enqueueChannelTask()` used.",
    },
    AGENT_CHANNEL_TASK_NAME_MISSING: {
      why: ({ method, target }: { method: "cancelChannelTask" | "enqueueChannelTask" | "sendChannelTrigger", target: "task" | "trigger" }) => `[vitehub] ${method}() needs a non-empty Channel name and ${target} name.`,
      fix: "Pass a non-empty Channel name and a non-empty task or trigger name to the function that the message names.",
    },
    AGENT_CHANNEL_TASK_NOT_BEFORE_INVALID: {
      why: "[vitehub] enqueueChannelTask() notBefore must be a valid Date or a finite timestamp.",
      fix: "Pass `notBefore` to `enqueueChannelTask()` as a valid `Date` or a timestamp in milliseconds.",
    },
    AGENT_CHANNEL_TASK_QUEUE_MISSING: {
      why: ({ channel }: { channel: string }) => `[vitehub] Channel "${channel}" has no running webhook queue. Channel tasks need a declared Channel webhook and durable SQLite or libSQL Agent State in the same persistent Node server. Standalone serverless Schedule and API entries are not supported.`,
      fix: "Declare a webhook for the Channel, give the Agent SQLite or libSQL Agent State, and call the function from the persistent Node server that hosts the webhook.",
    },
    AGENT_CHANNEL_TASK_START_CONFLICT: {
      why: "[vitehub] enqueueChannelTask() takes notBefore or delayMs, not both.",
      fix: "Pass `notBefore` or `delayMs` to `enqueueChannelTask()`, not both.",
    },
    AGENT_CHANNEL_TASK_TRIGGER_AMBIGUOUS: {
      why: ({ channel, task, triggers }: { channel: string, task: string, triggers: string }) => `[vitehub] More than one trigger of Channel "${channel}" declares task "${task}" (${triggers}). Pass the trigger option.`,
      fix: "Pass the `trigger` option with one of the triggers that the message lists.",
    },
    AGENT_CHANNEL_TASK_UNDECLARED: {
      why: ({ channel, task, trigger }: { channel: string, task: string, trigger?: string }) => `[vitehub] No trigger of Channel "${channel}" declares task "${task}"${trigger === undefined ? "" : ` as trigger "${trigger}"`}.`,
      fix: "Pass the name of a task that a trigger of the Channel declares in its `tasks`, or add the task to the `tasks` of a trigger.",
    },
    AGENT_CHANNEL_TRIGGER_UNKNOWN: {
      why: ({ channel, trigger }: { channel: string, trigger: string }) => `[vitehub] Channel "${channel}" has no trigger or \`on\` handler "${trigger}".`,
      fix: "Pass `sendChannelTrigger()` the name of a trigger or an `on` handler of the Channel.",
    },
    AGENT_CHANNEL_WEBHOOK_MISSING: {
      why: ({ channel, target, name }: { channel: string, target: "task" | "trigger", name: string }) => `[vitehub] Channel "${channel}" declares no webhook, so it has no queue for ${target} "${name}".`,
      fix: "Declare a webhook for the Channel that the message names.",
    },
    AGENT_DISPATCH_QUEUE_UNAVAILABLE: {
      why: ({ channelId }: { channelId: string }) => `[vitehub] Channel "${channelId}" can queue dispatched items only from its webhook route with a queue-capable State.`,
      fix: "Call `dispatch(items, { queue: true })` only in a trigger that runs from the Channel webhook route, and give the Agent SQLite or libSQL Agent State.",
    },
    AGENT_DISPATCH_TRIGGER_UNKNOWN: {
      why: ({ channel, trigger }: { channel: string, trigger: string }) => `[vitehub] Channel "${channel}" has no trigger "${trigger}" to dispatch to.`,
      fix: "Set `dispatch(items, { trigger })` to the name of a trigger of the Channel.",
    },
    AGENT_FORGE_ACTIVITY_FAILED: {
      why: "[vitehub] Forge pull request activity initialization failed.",
      fix: "Check that the Forge token can write comments in the repository. Read `error.cause` for the Forge error.",
    },
    AGENT_FORGE_ACTIVITY_TARGET_INVALID: {
      why: "[vitehub] Forge Agent activity requires a target with repository and issue.",
      fix: "Set `run.activity.target` to `{ repository: \"owner/name\", issue: <number> }` when you start the Invocation.",
    },
    AGENT_FORGE_AGENT_IDENTITY_MISSING: {
      why: "[vitehub] Forge activity session links require an Agent identity.",
      fix: "Start the Invocation through a named Agent, or remove `publicUrl` from the `activity` option of the Channel.",
    },
    AGENT_FORGE_EFFECT_FAILED: {
      why: ({ status }: { status: number }) => `[vitehub] Forge delivery effect failed with ${status}.`,
      fix: "Check that the Forge token can write issues and merge requests or pull requests in the repository. Read `error.cause` for the Forge error. A retry helps only for 429 or 5xx.",
    },
    AGENT_FORGE_IDENTITY_UNRESOLVED: {
      why: "[vitehub] Forge Agent activity could not resolve the authenticated identity.",
      fix: "Set the Channel `token`, VITEHUB_GITLAB_TOKEN, or VITEHUB_FORGEJO_TOKEN to a token that can read its own user.",
    },
    AGENT_FORGE_LIFECYCLE_UPDATE_UNSUPPORTED: {
      why: "[vitehub] Forge pull request lifecycle invocations cannot update a triggering comment.",
      fix: "Call `message.reply()` instead of `message.update()` when a pull request event starts the Invocation, because no triggering comment exists.",
    },
    AGENT_FORGE_METADATA_FAILED: {
      why: ({ status }: { status: number }) => `[vitehub] Forge metadata request failed with ${status}.`,
      fix: "Check that the Forge token can read the repository and its merge requests or pull requests. Read `error.cause` for the Forge error. A retry helps only for 429 or 5xx.",
    },
    AGENT_FORGE_REVIEW_UNSUPPORTED: {
      why: "[vitehub] GitLab has no request changes review. Use an approve or comment review.",
      fix: "Send an `APPROVE` or `COMMENT` review effect to a `gitlab()` Channel.",
    },
    AGENT_FORGE_WEBHOOK_SECRET_MISSING: {
      why: ({ kind }: { kind: "forgejo" | "gitlab" }) => `[vitehub] ${kind}() requires webhookSecret or ${kind.toUpperCase()}_WEBHOOK_SECRET.`,
      fix: "Set `webhookSecret` in the Channel options, or set VITEHUB_GITLAB_WEBHOOK_SECRET or VITEHUB_FORGEJO_WEBHOOK_SECRET.",
    },
    AGENT_GITHUB_PULL_REQUEST_TRIGGER_DISABLED: {
      why: ({ trigger }: { trigger: string }) => `[vitehub] The github() Channel has the pull request trigger "${trigger}", but \`pullRequest\` is not set, so the Channel does not read pull request events.`,
      fix: "Set `pullRequest` on the github() Channel, such as `pullRequest: { reply: false }`, or remove the trigger.",
    },
    AGENT_GMAIL_AGENT_AMBIGUOUS: {
      why: ({ agents }: { agents: string }) => `[vitehub] gmailChannelStatus() found more than one Agent that uses this Channel: ${agents}. Pass the \`agent\` option.`,
      fix: "Pass `gmailChannelStatus(channel, { agent })` with the name of one Agent that the message lists.",
    },
    AGENT_GMAIL_AGENT_MISSING: {
      why: "[vitehub] pollGmailChannel() found no Agent that uses this Channel.",
      fix: "Pass `pollGmailChannel()` a Gmail Channel that an Agent of the app uses.",
    },
    AGENT_GMAIL_CHANNEL_EXPECTED: {
      why: ({ method }: { method: "gmailChannelStatus" | "gmailClient" | "pollGmailChannel" | "syncGmailChannel" }) => `[vitehub] ${method}() expects a Channel from gmail().`,
      fix: "Pass the Channel that `gmail()` returns to the function that the message names.",
    },
    AGENT_GMAIL_LABEL_MISSING: {
      why: ({ name }: { name: string }) => `[vitehub] Gmail label "${name}" does not exist. Declare it in gmail({ labels }) or create it in Gmail.`,
      fix: "Declare the label in `gmail({ labels })`, or create it in Gmail.",
    },
    AGENT_GMAIL_OPTIONS_INVALID: {
      why: ({ detail }: { detail: string }) => `[vitehub] gmail() ${detail}`,
      fix: "Change the `gmail()` option that the message names to the value that the message asks for.",
    },
    AGENT_GMAIL_POLL_HOST_MISSING: {
      why: "[vitehub] pollGmailChannel() needs the Agent webhook routes of this app in the same process, with durable Agent State: libSQL with VITEHUB_AGENT_STATE_URL or Cloudflare Durable Objects.",
      fix: "Call `pollGmailChannel()` in the app that serves the Agent webhook routes, and set VITEHUB_AGENT_STATE_URL to a libSQL database or use Cloudflare Durable Objects.",
    },
    AGENT_INVOCATIONS_COMPACT_BUSY: {
      why: ({ label, busyTimeoutMs }: { label: string, busyTimeoutMs: number }) => `${label} is busy. VACUUM needs the write lock, and another process held it for more than ${busyTimeoutMs} ms. Stop the server that uses the journal, or run compact during a quiet window.`,
      fix: "Stop the server that uses the journal, or run `compact` again when no process writes to it.",
    },
    AGENT_INVOCATIONS_COMPACT_FILE_REQUIRED: {
      why: ({ remote }: { remote?: string }) => remote === undefined
        ? "compact rebuilds a local SQLite file. An in-memory database has no file to compact. Pass --database with a local file path."
        : `compact rebuilds a local SQLite file. ${remote} is a remote libSQL database, which manages its own storage. Pass --database with a local file path.`,
      fix: "Pass `--database` with the path of a local SQLite journal file.",
    },
    AGENT_INVOCATIONS_COMPACT_SPACE: {
      why: ({ label, liveBytes, volumes }: { label: string, liveBytes: number, volumes: string[] }) => [
        `Not enough free space to compact ${label}. VACUUM writes a copy of the ${liveBytes} live bytes and a journal of about the same size.`,
        ...volumes,
        "Free space on the volume, or set SQLITE_TMPDIR to a directory on another volume for the temporary copy.",
      ].join("\n"),
      fix: "Free space on the volume, or set SQLITE_TMPDIR to a directory on another volume for the temporary copy.",
    },
    AGENT_INVOCATIONS_DATABASE_NOT_FILE: {
      why: "--database for list, show, tail, export, and wait-idle reads a local SQLite file. Use --url for a deployed app.",
      fix: "Pass `--url` with the app URL to read a deployed app, or pass `--database` with a local SQLite file path.",
    },
    AGENT_INVOCATIONS_DATABASE_URL_INVALID: {
      why: "The Agent Invocation journal database URL is invalid.",
      fix: "Set `--database` or VITEHUB_AGENT_INVOCATIONS_DATABASE_URL to a valid URL, such as `libsql://<host>`, or to a file path.",
    },
    AGENT_INVOCATIONS_DURATION_INVALID: {
      why: ({ flag }: { flag: string }) => `${flag} requires a duration such as 90m, 12h, or 30d.`,
      fix: "Pass the flag that the message names a number with a unit, such as `90m`, `12h`, or `30d`.",
    },
    AGENT_INVOCATIONS_JOURNAL_FAILED: {
      why: ({ message }: { message: string }) => message,
      fix: "Check that the journal database is reachable and that VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN is valid. Retry when the database is available again.",
    },
    AGENT_INVOCATIONS_JOURNAL_MISSING: {
      why: ({ location, hint }: { location: string, hint?: "Pass --database with the journal file, or --url with the app URL." | "Pass --database with the journal file." | "Pass --database with the journal URL." }) => `No Agent Invocation journal exists at ${location}.${hint ? ` ${hint}` : ""}`,
      fix: "Pass `--database` with the journal file that the app writes, or `--url` with the app URL.",
    },
    AGENT_INVOCATIONS_JOURNAL_TABLE_MISSING: {
      why: ({ table, location }: { table: string, location: string }) => `No Agent Invocation journal table ${table} exists in ${location}.`,
      fix: "Pass `--table-prefix` with the `tablePrefix` that the app uses, or pass `--database` with the journal that the app writes.",
    },
    AGENT_INVOCATIONS_NODE_SQLITE_MISSING: {
      why: "--database reads the journal with node:sqlite, which this runtime does not provide. Run the command with Node.js 24.15 or newer, or pass --url.",
      fix: "Run the command with Node.js 24.15 or newer, or pass `--url` with the app URL.",
    },
    AGENT_INVOCATIONS_PRUNE_CUTOFF_INVALID: {
      why: "--older-than must produce a cutoff within JavaScript's Date range.",
      fix: "Pass a shorter `--older-than` duration, such as `30d`.",
    },
    AGENT_INVOCATIONS_SIZE_INVALID: {
      why: ({ flag }: { flag: string }) => `${flag} requires a size such as 500MB or 3GB, a number of bytes, or a percent of the volume such as 30%.`,
      fix: "Pass `--max-size` a size such as `500MB`, a number of bytes, or a percent of the volume such as `30%`.",
    },
    AGENT_INVOCATIONS_TABLE_PREFIX_INVALID: {
      why: "--table-prefix must be alphanumeric.",
      fix: "Pass `--table-prefix` with letters, digits, and underscores only, such as `vitehub_agent_`.",
    },
    AGENT_INVOCATION_NOT_FOUND: {
      why: ({ id, location }: { id: string, location: string }) => `Agent Invocation ${id} was not found in ${location}.`,
      fix: "Pass an Invocation ID that `vitehub agent invocations list` shows for the same `--database`.",
    },
  },
})

type Guarded<TGuard> = TGuard extends (error: unknown) => error is infer TError ? TError : never

/**
 * Every Agent diagnostic handle. A spread does not copy the non-enumerable `is` of each registry,
 * so `is` is defined again here and checks both registries.
 */
export const agentDiagnostics: Omit<typeof agentDiagnosticHandles & typeof messageDiagnostics, "is"> & {
  is: (error: unknown) => error is Guarded<typeof agentDiagnosticHandles.is> | Guarded<typeof messageDiagnostics.is>
} = /*#__PURE__*/ Object.defineProperty({ ...agentDiagnosticHandles, ...messageDiagnostics }, "is", {
  value: (error: unknown) => agentDiagnosticHandles.is(error) || messageDiagnostics.is(error),
})

/** Preserves input-error HTTP status for application TypeErrors and Agent diagnostics. */
export function isAgentTypeDiagnostic(error: unknown): boolean {
  try {
    return error instanceof TypeError || isRuntimeDiagnostic(error) && agentTypeDiagnosticCodes.has(error.code)
  }
  catch {
    return false
  }
}
