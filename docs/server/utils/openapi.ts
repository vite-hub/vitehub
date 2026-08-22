const textResponse = (description: string, mediaType = "text/plain") => ({
  description,
  content: {
    [mediaType]: {
      schema: { type: "string" },
    },
  },
});

const problemResponse = {
  description: "The requested ViteHub resource was not found.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Problem" },
    },
    "text/markdown": {
      schema: { type: "string" },
    },
  },
};

export const viteHubOpenApi = {
  openapi: "3.1.0",
  info: {
    title: "ViteHub developer resources API",
    version: "1.0.0",
    description: "Public documentation indexes, raw Markdown, Agent Skills, and discovery resources served by vitehub.dev. ViteHub itself runs inside each application; this document does not describe a shared hosted application runtime.",
    license: {
      name: "Apache-2.0",
      identifier: "Apache-2.0",
    },
  },
  servers: [
    {
      url: "https://vitehub.dev",
      description: "Canonical ViteHub documentation host",
    },
  ],
  security: [],
  tags: [
    {
      name: "Documentation",
      description: "Indexes and source Markdown for ViteHub documentation.",
    },
    {
      name: "Agent Skills",
      description: "Machine-readable Agent Skill discovery and files.",
    },
    {
      name: "Discovery",
      description: "Site and API discovery documents.",
    },
  ],
  paths: {
    "/openapi.json": {
      get: {
        operationId: "getViteHubOpenApi",
        summary: "Read the ViteHub developer resources API document",
        description: "Returns this OpenAPI 3.1 document for the public machine-readable resources on vitehub.dev.",
        tags: ["Discovery"],
        responses: {
          "200": {
            description: "The ViteHub OpenAPI document.",
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          "404": problemResponse,
        },
      },
    },
    "/llms.txt": {
      get: {
        operationId: "getViteHubLlmsIndex",
        summary: "Read the compact ViteHub documentation index",
        description: "Returns use-case guidance and links to the smallest ViteHub documentation resource for an agent task.",
        tags: ["Documentation"],
        responses: {
          "200": textResponse("The compact ViteHub documentation index."),
          "404": problemResponse,
        },
      },
    },
    "/llms-full.txt": {
      get: {
        operationId: "getViteHubFullDocumentation",
        summary: "Read the complete ViteHub documentation corpus",
        description: "Returns the combined ViteHub documentation corpus for broad analysis. Prefer llms.txt and one raw page for focused tasks.",
        tags: ["Documentation"],
        responses: {
          "200": textResponse("The complete ViteHub documentation corpus."),
          "404": problemResponse,
        },
      },
    },
    "/raw/docs.md": {
      get: {
        operationId: "getViteHubDocumentationIndexMarkdown",
        summary: "Read the ViteHub documentation index as raw Markdown",
        description: "Returns the canonical source Markdown for the ViteHub documentation index. Follow its links or use llms.txt to select a focused page.",
        tags: ["Documentation"],
        responses: {
          "200": textResponse("The ViteHub documentation index as source Markdown.", "text/markdown"),
          "404": problemResponse,
        },
      },
    },
    "/raw/{page}.md": {
      get: {
        operationId: "getViteHubTrustPageMarkdown",
        summary: "Read a ViteHub trust page as raw Markdown",
        description: "Returns the canonical source Markdown for the ViteHub about, contact, or privacy page.",
        tags: ["Documentation"],
        parameters: [
          {
            name: "page",
            in: "path",
            required: true,
            description: "The trust page to retrieve.",
            schema: {
              type: "string",
              enum: ["about", "contact", "privacy"],
            },
          },
        ],
        responses: {
          "200": textResponse("The selected ViteHub trust page as source Markdown.", "text/markdown"),
          "404": problemResponse,
        },
      },
    },
    "/.well-known/skills/index.json": {
      get: {
        operationId: "listViteHubAgentSkills",
        summary: "List ViteHub Agent Skills",
        description: "Returns the public Agent Skill catalog with each skill name, when-to-use description, and file list.",
        tags: ["Agent Skills"],
        responses: {
          "200": {
            description: "The ViteHub Agent Skill catalog.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["skills"],
                  properties: {
                    skills: {
                      type: "array",
                      items: { $ref: "#/components/schemas/AgentSkill" },
                    },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
          "404": problemResponse,
        },
      },
    },
    "/.well-known/skills/vitehub/SKILL.md": {
      get: {
        operationId: "getViteHubAgentSkillInstructions",
        summary: "Read the ViteHub Agent Skill instructions",
        description: "Returns the canonical ViteHub Agent Skill with when-to-use guidance and links to its routed references.",
        tags: ["Agent Skills"],
        responses: {
          "200": textResponse("The ViteHub Agent Skill instructions.", "text/markdown"),
          "404": problemResponse,
        },
      },
    },
    "/sitemap.xml": {
      get: {
        operationId: "getViteHubSitemap",
        summary: "Read the ViteHub sitemap",
        description: "Returns the canonical rendered-page URLs published by vitehub.dev.",
        tags: ["Discovery"],
        responses: {
          "200": textResponse("The ViteHub XML sitemap.", "application/xml"),
          "404": problemResponse,
        },
      },
    },
  },
  components: {
    schemas: {
      AgentSkill: {
        type: "object",
        required: ["name", "description", "files"],
        properties: {
          name: { type: "string", description: "Stable Agent Skill identifier." },
          description: { type: "string", description: "Specific guidance about when to use the skill." },
          files: {
            type: "array",
            description: "Relative files available for the skill.",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
      Problem: {
        type: "object",
        required: ["statusCode", "statusMessage"],
        properties: {
          statusCode: { type: "integer", minimum: 400, maximum: 599 },
          statusMessage: { type: "string" },
        },
        additionalProperties: true,
      },
    },
  },
} as const;
