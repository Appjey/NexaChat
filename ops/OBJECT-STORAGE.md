# Object storage (MinIO) — image, bucket, volume ownership

## Why the image changed (October 2026)

In September 2026 MinIO removed the `minio/minio` and `minio/mc` repositories
from Docker Hub and quay.io stopped serving anonymous pulls. Any machine
without those images already cached — a new dev laptop, a rebuilt VM, a CI
runner — failed with `pull access denied for minio/minio`. Prod kept running
only because the image was already cached on the VM.

Both compose files now use **Chainguard's MinIO build**:

```
cgr.dev/chainguard/minio:latest@sha256:<digest>
```

* Same upstream `minio` binary built from source (the pinned digest is
  `RELEASE.2026-09-22T19-25-18Z`), same `/data` on-disk layout, so the existing
  `minio_data` volume is used as-is — no migration.
* Honours `MINIO_ROOT_PASSWORD_FILE`, so the prod Docker-secrets wiring is
  unchanged.
* Pulls anonymously. The free tier only publishes a moving `latest` tag, so the
  compose files pin the multi-arch index **digest**. To bump:

  ```bash
  docker buildx imagetools inspect cgr.dev/chainguard/minio:latest
  ```

  Copy the top-level `Digest:` into both `docker-compose.yml` and
  `docker-compose.prod.yml`, and note the `minio --version` it carries.

We stayed on MinIO rather than migrating to Garage/SeaweedFS/RustFS because
the backend only needs plain S3 (`PutObject`/`GetObject`/`CopyObject`/
`DeleteObject` + presigned GET) and the prod volume already holds MinIO's
erasure-coded layout; a store swap would mean a data migration for no feature
gain. If Chainguard ever stops publishing the image, the same compose block
works with any image that runs `minio server /data`.

## Bucket creation moved into the backend

The old `minio-init` one-shot service (`mc mb --ignore-existing` from the
deleted `minio/mc` image) is gone from both compose files. On startup the
backend now does `HeadBucket` and, if the bucket is missing, `CreateBucket`
(`backend/internal/storage/s3_storage.go`, `EnsureBucket`). It is idempotent
and logs either `S3 bucket ready` or `Created S3 bucket`. If it fails, the
backend exits with `initialize storage: ensure bucket: ...` and the
`restart: unless-stopped` policy retries.

`MINIO_BUCKET_NAME` is therefore no longer read by anything; the bucket name
comes from `STORAGE_S3_BUCKET` (default `messenger-uploads`) only.

## Volume ownership: why `user: "0:0"`

The old `minio/minio` image started as root, so everything under the
`minio_data` volume is owned by `0:0`. Chainguard's image defaults to the
`nonroot` user (uid/gid 65532), which cannot write a root-owned `/data`.
Both compose files therefore set `user: "0:0"` on the `minio` service — the
same privilege level the old image ran with, and zero-touch for the existing
prod volume.

To run MinIO as nonroot instead (optional hardening), do a one-time chown on
the VM while the service is stopped, then drop the `user:` line:

```bash
docker compose -f docker-compose.prod.yml stop minio
docker run --rm -v nothing_minio_data:/data --entrypoint chown \
  cgr.dev/chainguard/minio:latest -R 65532:65532 /data
# remove `user: "0:0"` from the minio service, then
docker compose -f docker-compose.prod.yml up -d minio
```

(Check the real volume name with `docker volume ls | grep minio_data`; it is
prefixed with the compose project name.) The `minio_root_password` secret is
already `root:65532 0640` (see `SECRETS.md`), so nonroot can read it.

## Rolling this out on prod

The release pipeline only runs `docker compose pull backend frontend && up -d
backend frontend`. Because `minio` is a dependency of `backend` whose config
changed, that `up` recreates `minio` with the new image on the next deploy;
the first pull from `cgr.dev` takes a few seconds and the bucket is untouched.
The orphaned `minio-init` container just needs removing once:

```bash
docker compose -f docker-compose.prod.yml up -d --remove-orphans
```

## Healthcheck

The service healthcheck no longer calls `mc`. It is a bash `/dev/tcp` HTTP
probe of `GET /minio/health/live` expecting `200`, so it works on any image
that has bash and does not depend on the client binary being present.
