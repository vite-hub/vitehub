# Storage Capability Tool Surfaces

Storage primitive Capabilities are first-class Agent Capabilities that wrap configured primitive handles from the Capability context rather than importing runtime packages directly. KV and Blob use small read/edit tool surfaces with developer-scoped prefix discovery, while DB keeps database-native tools (`db_schema`, `db_query`, `db_exec`) because SQL agents already understand schema/query/execute language.

Blob ships as direct object storage for generated or uploaded artifacts even though Workspace may use Blob-backed persistence; Workspace remains the default model-facing file-tree boundary. DB separates data `mode` from `schemaMode`, requires single-statement SQL, gates writes behind approval by default, and can explicitly mutate the Live Database Schema without updating Database Schema Sources.
