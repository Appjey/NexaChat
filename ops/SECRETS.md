# Production secret layout

Production deploys load every sensitive value (database password, JWT secret,
MinIO root password, VAPID private key, FCM service account JSON) from files
mounted into the containers via Docker Compose `secrets:`, not from
environment variables. This document covers the one-time operator setup and
the migration from the previous `.env`-only deployment.

> `MESSAGE_ENCRYPTION_KEY` used to live here too — for legacy server-side
> message encryption. After the migration to client-side E2E (X25519 +
> AES-GCM) the backend no longer reads it. The file can stay on the host as
> a no-op or be removed after a fresh deploy.

The non-sensitive bits (POSTGRES_USER, ALLOWED_ORIGINS, REGISTRY, TAG, VAPID
public key, etc.) stay in `~/nothing/.env` as before.

## Why

Before:

```
~/nothing/.env                       # mode 664, vpmuser can `cat`
   JWT_SECRET=...                    # in every `docker inspect messenger-backend`
   POSTGRES_PASSWORD=...             # ditto
   MINIO_ROOT_PASSWORD=...           # ditto
   VAPID_PRIVATE_KEY=...             # ditto
~/nothing/fcm-credentials.json       # mode 644, world-readable on the host
```

Any SSH session as `vpmuser` was a one-`cat` exfiltration of every secret.

After:

```
/etc/messenger/secrets/              # mode 750, root:docker
   postgres_password                 # mode 640, root:65532
   minio_root_password               # mode 640, root:65532
   jwt_secret                        # mode 640, root:65532
   vapid_private_key                 # mode 640, root:65532
   db_url                            # mode 640, root:65532
   fcm_credentials.json              # mode 640
~/nothing/.env                       # only non-sensitive values left
```

* The `secrets/` directory is `/etc/messenger/` (owned by `root:docker` 0750) —
  cleanly outside `vpmuser`'s home, no way to land there by accident.
* The files themselves are `root:65532 0640` — see below for why **`65532`**
  rather than `root:docker`.
* `docker inspect messenger-backend` no longer prints values — only the
  `*_FILE` paths into `/run/secrets/`. To read the actual secret you have
  to be inside the container, or on the host with `sudo`, or as a member
  of the magic group 65532 (which doesn't exist by name on the host).

### Why ownership is `root:65532`, not `root:docker`

The backend image is `gcr.io/distroless/static-debian12:nonroot`. That ships
a single non-root user with **uid 65532, gid 65532**, and no shell. So the
Go binary runs as uid 65532 inside its container. Bind-mounted secret files
keep their host ownership inside the container — there's no remapping. That
means our backend reads `/run/secrets/jwt_secret` as gid 65532, and the only
way to grant access is to make gid 65532 the group on the host file.

Postgres / MinIO are fine either way: Postgres' entrypoint starts as root,
reads the password file, then drops privileges, and the MinIO service runs as
root (`user: "0:0"`, see `OBJECT-STORAGE.md`) — so both go through the uid 0
path. (The former `minio-init` job is gone; the backend creates the bucket.)

Side-benefit: gid 65532 doesn't correspond to any real user on the host (no
matching entry in `/etc/group`), so `vpmuser` (gid 1000) genuinely can't read
the files, even though it's in the `docker` group. The boundary is real,
not just nominal.

## First-time setup (run as root on the production host)

```sh
# 0. Move into the project dir as a sanity check
cd /home/vpmuser/nothing

# 1. Create the secrets directory with correct ownership and mode
sudo install -d -m 0750 -o root -g docker /etc/messenger/secrets

# 2. Lift each value out of the current .env into its own file.
#    The `tr -d '\r'` is load-bearing: if the .env was last saved on Windows
#    it has CRLF line endings, and naive grep|cut leaves a trailing \r in the
#    value. Trailing CR is mostly harmless (backend's readEnvOrFile trims it),
#    but for the synthesized db_url below the \r ends up MID-string and the
#    Postgres URL parser rejects the connection ("invalid control character").
#    Files are written with mode 0640 root:65532 — see "Why ownership is
#    root:65532" above for why not root:docker.
extract() {
  local key="$1" out="$2"
  grep "^${key}=" .env | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' \
    | sudo tee "/etc/messenger/secrets/${out}" >/dev/null
  sudo chmod 0640 "/etc/messenger/secrets/${out}"
  sudo chown root:65532 "/etc/messenger/secrets/${out}"
}

extract POSTGRES_PASSWORD       postgres_password
extract MINIO_ROOT_PASSWORD     minio_root_password
extract JWT_SECRET              jwt_secret
extract VAPID_PRIVATE_KEY       vapid_private_key

# 3. Build the DB URL from the parts already in .env + the password file.
#    Every component goes through `tr -d '\r'` so the resulting URL is pure
#    ASCII without embedded carets. `printf` (not `echo`) keeps us from
#    adding a trailing newline that the parser would have to swallow.
pgu=$(grep '^POSTGRES_USER=' .env | cut -d= -f2 | tr -d '\r')
pgu=${pgu:-messenger}
pgd=$(grep '^POSTGRES_DB=' .env | cut -d= -f2 | tr -d '\r')
pgd=${pgd:-messenger}
pgp=$(sudo cat /etc/messenger/secrets/postgres_password | tr -d '\r\n')
printf 'postgres://%s:%s@postgres:5432/%s?sslmode=disable' "$pgu" "$pgp" "$pgd" \
  | sudo tee /etc/messenger/secrets/db_url >/dev/null
sudo chmod 0640 /etc/messenger/secrets/db_url
sudo chown root:65532 /etc/messenger/secrets/db_url

# 4. Move the FCM credentials file in. The old volume mount in compose is gone;
#    it's now a Docker secret.
sudo cp fcm-credentials.json /etc/messenger/secrets/fcm_credentials.json
sudo chmod 0640 /etc/messenger/secrets/fcm_credentials.json
sudo chown root:65532 /etc/messenger/secrets/fcm_credentials.json

# 5. Verify each file looks right
sudo ls -l /etc/messenger/secrets/
# expected: drwxr-x---  root docker and  -rw-r----- root 65532  for each file
```

Verify it worked from `vpmuser` without `sudo`:

```sh
ls -l /etc/messenger/secrets/   # works — directory is r-x for docker group
cat /etc/messenger/secrets/jwt_secret  # "Permission denied" — vpmuser is not in gid 65532

# `nobody` is also not in gid 65532, so the same check confirms least privilege:
sudo -u nobody cat /etc/messenger/secrets/jwt_secret
# → "Permission denied"
```

## After setup: trim the .env

The `.env` no longer needs (and **must not** contain) the sensitive values.
Comment-out or delete the following keys — they're now in `/etc/messenger/secrets/`:

```
# POSTGRES_PASSWORD       — moved to /etc/messenger/secrets/postgres_password
# MINIO_ROOT_PASSWORD     — moved to /etc/messenger/secrets/minio_root_password
# JWT_SECRET              — moved to /etc/messenger/secrets/jwt_secret
# VAPID_PRIVATE_KEY       — moved to /etc/messenger/secrets/vapid_private_key
```

Keep the rest (POSTGRES_USER, POSTGRES_DB, ALLOWED_ORIGINS, MINIO_ROOT_USER,
STORAGE_S3_BUCKET, REGISTRY, TAG, VAPID_PUBLIC_KEY, VAPID_SUBJECT, etc.) —
those are not sensitive.

Optional but recommended: tighten the remaining `.env` since it still tells
attackers a lot about the deployment shape:

```sh
chmod 0640 ~/nothing/.env
```

## Roll out

```sh
cd ~/nothing
# Pull the latest docker-compose.prod.yml from main (already references secrets:)
git pull origin main   # or however you ship config to the host
# Restart with the new layout
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs --tail=50 backend
# Backend log should show normal startup. If you see "JWT_SECRET is not set" or
# similar, the secret file path doesn't match — re-check step 2 above.
```

## Rotating a secret

To rotate, e.g., the JWT secret:

```sh
NEW=$(openssl rand -base64 48 | tr -d '\n')
echo -n "$NEW" | sudo tee /etc/messenger/secrets/jwt_secret >/dev/null
sudo chmod 0640 /etc/messenger/secrets/jwt_secret
sudo chown root:65532 /etc/messenger/secrets/jwt_secret
docker compose -f docker-compose.prod.yml restart backend
```

Note: rotating `JWT_SECRET` invalidates every existing user session (since
existing tokens were signed with the old secret). After the E2E migration
this is actually the *intended* way to force every user through their next
login → vault bootstrap → public_key upload, in one go.

## Backups

`/etc/messenger/secrets/` is **not** in git, **not** in CI artifacts, and not
included in the regular `postgres_data` / `minio_data` volume backups.
Back it up manually to an encrypted location (USB stick, GPG-encrypted blob
in S3, password manager attachments) the first time you set it up. Without
it, the postgres data and message ciphertexts in `messages.text` are
irrecoverable.

## CI / autodeploy

The `deploy` job in `.github/workflows/ci.yml` rsyncs `docker-compose.prod.yml`
and `nginx-proxy/` to the host and runs `docker compose up -d`. It deliberately
does **not** touch `/etc/messenger/secrets/` — secrets never travel through
CI. The CI run will simply fail to start the backend if the secret files are
missing on the host. So: run the first-time setup above **before** the first
CI deploy of the new compose.
