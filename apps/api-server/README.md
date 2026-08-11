# @cinevfx/api-server

Dependency-light, metadata-only **Mock API** for the CineVFX vertical slice.

This package implements the six frozen contract endpoints using **Node built-ins
only**. It validates asset and job metadata against the frozen
`packages/contracts` schemas, advances jobs through a deterministic monotonic
lifecycle, publishes fixed generic editable Layer Manifests, and redacts
sensitive fields from logs.

No image bytes, models, providers, renderer services, or network-fetched
dependencies are used.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/assets` | Register asset metadata (proxy, mask, effect reference, …) |
| `POST` | `/v1/jobs` | Create or replay an idempotent job (`Idempotency-Key` required) |
| `GET` | `/v1/jobs/{id}` | Fetch current `JobStatus` |
| `GET` | `/v1/jobs/{id}/events` | List ordered events (`afterSequence` optional) |
| `POST` | `/v1/jobs/{id}/cancel` | Request cancellation (idempotent when already cancelled) |
| `GET` | `/v1/jobs/{id}/manifest` | Fetch validated Layer Manifest (succeeded jobs only) |

The six frozen endpoints:

- `POST /v1/assets`
- `POST /v1/jobs`
- `GET /v1/jobs/{id}`
- `GET /v1/jobs/{id}/events`
- `POST /v1/jobs/{id}/cancel`
- `GET /v1/jobs/{id}/manifest`

Business endpoint and JSON-model authority: `openapi/openapi.json` (repository
root). Local TLS, loopback, `/healthz`, session header, request bounds, and the
complete effective response-status surface are independently frozen in
`openapi/local-development-transport.json`.

## Local usage

From the repository root (or this package directory):

```bash
# syntax / structure check
pnpm --dir apps/api-server check

# package tests (in-process + HTTP)
pnpm --dir apps/api-server test

# local build smoke (writes dist/build-manifest.json)
pnpm --dir apps/api-server build

# explicit local HTTP opt-in (TLS is the CLI default)
CINEVFX_MOCK_ALLOW_HTTP=1 pnpm --dir apps/api-server start
```

Environment overrides:

- `CINEVFX_MOCK_HOST` (`localhost` by default; `127.0.0.1` is the only alternative)
- `CINEVFX_MOCK_PORT` (fixed at `8787` for CLI startup)
- `CINEVFX_MOCK_TLS_CERT_FILE` (PEM certificate file; required by default)
- `CINEVFX_MOCK_TLS_KEY_FILE` (matching PEM private-key file; required by default)
- `CINEVFX_MOCK_ALLOW_HTTP=1` (explicit local HTTP opt-in when TLS is not configured)

The canonical CLI endpoint is `https://localhost:8787`. The two TLS file
variables are an all-or-nothing pair. If either variable is missing, empty,
unreadable, or contains unusable material, startup fails rather than falling
back to HTTP. Programmatic callers can use
`listen({ tls: { cert, key } })` with PEM strings or buffers already in memory.
Programmatic tests may use `port: 0`; the CLI does not.

### Local HTTPS

The certificate must cover the hostname used by the client. The commands below
create a test-only self-signed certificate for `localhost` and `127.0.0.1`.
Keep the private key outside the repository and do not use it for production.

macOS with OpenSSL installed:

```bash
mkdir -p "$HOME/.cinevfx/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout "$HOME/.cinevfx/certs/mock-key.pem" \
  -out "$HOME/.cinevfx/certs/mock-cert.pem" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

chmod 700 "$HOME/.cinevfx" "$HOME/.cinevfx/certs"
chmod 600 "$HOME/.cinevfx/certs/mock-key.pem"

# Trust only for the current macOS login keychain.
security add-trusted-cert -d -r trustRoot \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  "$HOME/.cinevfx/certs/mock-cert.pem"

export CINEVFX_MOCK_TLS_KEY_FILE="$HOME/.cinevfx/certs/mock-key.pem"
export CINEVFX_MOCK_TLS_CERT_FILE="$HOME/.cinevfx/certs/mock-cert.pem"
pnpm --dir apps/api-server start

# Remove the development trust entry when finished.
CERT_SHA1=$(openssl x509 -in "$HOME/.cinevfx/certs/mock-cert.pem" \
  -noout -fingerprint -sha1 | cut -d= -f2 | tr -d ':')
security delete-certificate -Z "$CERT_SHA1" \
  "$HOME/Library/Keychains/login.keychain-db"
```

Windows PowerShell with OpenSSL installed:

```powershell
$certDir = Join-Path $env:LOCALAPPDATA "CineVFX\certs"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
openssl req -x509 -newkey rsa:2048 -nodes -days 365 `
  -keyout (Join-Path $certDir "mock-key.pem") `
  -out (Join-Path $certDir "mock-cert.pem") `
  -subj "/CN=localhost" `
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

$keyFile = Join-Path $certDir "mock-key.pem"
icacls $keyFile /inheritance:r /grant:r "${env:USERNAME}:(R)" | Out-Null

# Trust only for the current Windows user.
$trusted = Import-Certificate `
  -FilePath (Join-Path $certDir "mock-cert.pem") `
  -CertStoreLocation "Cert:\CurrentUser\Root"

$env:CINEVFX_MOCK_TLS_KEY_FILE = $keyFile
$env:CINEVFX_MOCK_TLS_CERT_FILE = Join-Path $certDir "mock-cert.pem"
pnpm --dir apps/api-server start

# Remove the development trust entry when finished.
Remove-Item "Cert:\CurrentUser\Root\$($trusted.Thumbprint)"
```

The process prints an `https://` base URL after a successful bind. Photoshop
must trust the development certificate through the current-user trust store.
Review each trust command before running it and remove the certificate when the
development session is no longer needed.
Photoshop/UXP certificate trust and runtime connectivity remain **UNVERIFIED**;
these steps only configure and test the local Mock API server.

### Local security boundary

This is a single-user development service without user-account authentication;
the per-process session token below is a local request guard, not an identity
system. Both the start script and programmatic `listen()` reject non-loopback
hosts; only `127.0.0.1` and `localhost` are accepted. The server does not enable
wildcard CORS or permissive `OPTIONS` responses. `POST /v1/assets` and
`POST /v1/jobs` require `Content-Type: application/json` (an optional charset is
accepted), preventing browser simple `text/plain` posts to the loopback API. Do
not expose this Mock server on a public or shared network.

Each server instance generates an unlogged local session token. Bootstrap with
`GET /healthz`, then send the returned token in `X-CineVFX-Session` on every
`/v1/*` request. The health response is `no-store`; startup output never prints
the token. Requests with missing or wrong tokens cannot mutate or probe job
state, and Host headers outside `localhost`/`127.0.0.1` are rejected to reduce
DNS-rebinding exposure.

If the UXP client is configured with an `https://` API URL, configure both TLS
environment variables above and use the exact `https://` base URL printed by
the server. The server requires TLS 1.2 or newer and never advertises HTTPS
without successfully loading a key and certificate. Windows HTTP development
requires the explicit `CINEVFX_MOCK_ALLOW_HTTP=1` opt-in. Cross-origin UXP fetch
behavior, manifest permissions, certificate trust, and Photoshop runtime
connectivity remain **UNVERIFIED**.

### Typical Mock flow

1. `GET /healthz` and retain its `sessionToken` in memory.
2. Send `X-CineVFX-Session` on every following `/v1/*` request.
3. `POST /v1/assets` for each input asset descriptor (metadata only).
4. `POST /v1/jobs` with a `JobRequest` body and matching `Idempotency-Key` header.
5. `GET /v1/jobs/{id}` and/or `GET /v1/jobs/{id}/events` for status.
6. On success, `GET /v1/jobs/{id}/manifest` for the validated editable passes.

Exact request replay with the same idempotency key returns **200** and the same
`jobId`. A reused key with a different body is rejected with **409**.
Exact `POST /v1/assets` metadata replay returns the stored descriptor with
**201**, matching the frozen OpenAPI response surface.

### Deterministic lifecycle outcomes

By default the Mock advances a valid job to `SUCCEEDED` immediately and
publishes a fixed generic Layer Manifest with editable passes and digest
agreement.

Label-based steers (effectSpec.label substrings) for local testing:

| Label contains | Outcome |
| --- | --- |
| `force-fail` / `mock-fail` | terminal `FAILED` |
| `force-expire` / `mock-expire` | terminal `EXPIRED` |
| `force-hold` / `mock-hold` | stop at `RENDERING` (for cancel tests) |

`options.dryRun: true` leaves the job in `CREATED`.
`options.ttlSeconds` at the schema minimum (`60`) forces `EXPIRED`.

Terminal states are immutable: cancel on a non-cancelled terminal job returns
**409**; cancel on an already cancelled job is idempotent (**200**).

## Bounds

- Max request body: 256 KiB
- Max assets: 256
- Max jobs: 128
- Max events per job: 256

Programmatic limits may be lowered for tests or constrained environments, but
cannot exceed these hard ceilings.

## Logging

Logs are JSON lines. Sensitive keys (`prompt`, credentials, paths, image
content fields, …) and path/token-like values are redacted. Do not expect image
bytes or absolute local paths in log output.

## Package layout

```text
apps/api-server/
  src/           # service, HTTP, lifecycle, manifest factory, redaction
  scripts/       # check, build, start
  tests/         # node:test suite
  README.md
  package.json
```

## Unverified / out of scope

- Persistence, authentication, multi-tenant isolation
- Real image transfer, storage backends, CDN
- AI models, ComfyUI, GPU providers, renderer services
- Production rate limiting and horizontal scaling

Those concerns are intentionally excluded from the Mock vertical slice.
