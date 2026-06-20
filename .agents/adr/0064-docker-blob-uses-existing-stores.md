# Docker Blob Uses Existing Stores

## Status

Accepted.

## Context

Docker-hosted apps still need Blob persistence, but Docker is not an object storage backend. Docker provides container writable layers, volumes, bind mounts, tmpfs mounts, volume drivers, and service wiring. Those mechanisms can make a filesystem path or object-storage service reachable from a container, but they do not expose Blob object operations, object metadata, prefix listing, signed access, provider credentials, or hosting runtime bindings.

The Blob model already separates storage identity from deployment reachability:

- **Blob Stores** name the configured storage backend.
- **Blob Store Selection** chooses one of those backends at runtime.
- **Provider Output** owns the deployment artifact and **Driver Reachability** for selected Blob Store drivers.

ViteHub already has the relevant Blob Stores for Docker deployments: `fs` for mounted filesystem persistence, `minio` for local or self-hosted S3-compatible object storage, and `s3` for managed or generic S3-compatible object storage.

## Decision

Docker does not get a Docker-specific Blob Store or `driver: "docker"`.

Docker Blob support means Docker Provider Output makes selected Blob Store drivers reachable:

- Use `fs` only for local or explicitly single-node Docker when the Blob root is mounted on a durable Docker volume or explicit host path.
- Use `minio` for Docker Compose, development, staging, and production-like object-storage testing.
- Use `s3` or production-grade S3-compatible object storage for shared production deployments.
- Allow `fs` for production only when the operator explicitly provides shared external filesystem storage and accepts that filesystem's durability and concurrency semantics.

Docker Provider Output may generate or document mounts, service dependencies, network aliases, environment variables, and optional peer dependency reachability for the selected Blob Store. It must not hide the actual storage choice behind Docker naming.

## Considered Options

- Adding `driver: "docker"` was rejected because it would mix host/runtime packaging with storage identity. It would still need to choose between container-local files, Docker volumes, bind mounts, shared filesystem drivers, MinIO, or S3, while making durability and multi-instance behavior less explicit.
- Defaulting all Docker hosting to `fs` was rejected because Docker local volumes are not shared storage for multi-instance deployments.
- Requiring every Docker deployment to use S3-compatible object storage was rejected because local and single-node Docker can use `fs` on a mounted volume without extra services.

## Consequences

Docker examples and future Docker Provider Output should preserve Blob Store Selection instead of adding a Docker Blob Driver Module.

The easy local path is still small:

```ts
blob: { driver: "fs", base: "/data/blob" }
```

The shared Docker object-storage path should be explicit:

```ts
blob: {
  driver: "minio",
  bucket: "vitehub-blob",
  endpoint: "http://minio:9000",
  forcePathStyle: true,
}
```

Production Docker guidance should prefer managed `s3` or an explicitly production-grade S3-compatible deployment. A single-host Docker Compose MinIO service is a development, staging, or test topology, not a production storage guarantee.

Tests and docs should call this Docker Provider Output or Blob Store Selection. They should not call it Docker Blob storage unless the surrounding text makes clear that Docker is only the host/runtime context.
