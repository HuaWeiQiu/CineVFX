# Development Preview Release Guide

This guide packages the current CineVFX Photoshop UXP **development preview**.
It does not create a signed CCX, assign a marketplace plugin id, or provide a
one-click formal installer. The artifact is an unpacked UXP Developer Tool
(UDT) load tree placed in a ZIP for transfer and checksum verification.

## Release Boundary

Included:

- Photoshop 2026 / 27.x-oriented Manifest v5 development panel
- Metadata-only proxy and protected-source planning
- Typed local Mock API client and task state
- Layer Manifest validation and rollback-safe import planning
- Generic effect-layer labels and contracts

Not included or verified:

- Real Photoshop pixel export/readback
- Real layer placement, `executeAsModal`, history, undo, or rollback
- Runtime proof of protected-source pixel/geometry preservation
- Windows or macOS Photoshop runtime acceptance
- Signed CCX, marketplace publication, or production plugin id
- AI/model providers, procedural rendering, native 8K, or quality guarantees

The user must separately install and be entitled to use a compatible Adobe
Photoshop 2026 build and UXP Developer Tool. This repository does not provide
Photoshop or an Adobe subscription.

## Build And Verify

From the repository root:

```bash
pnpm install
pnpm verify
```

`pnpm verify` runs package and root `check`, `test`, and `build` gates in order.
The UXP build and release validation/package step are included in that plan, so
CI verifies the actual four-file load tree before producing release metadata.

The UDT load tree is `apps/photoshop-uxp/dist/plugin/` and must contain exactly:

```text
manifest.json
index.html
index.js
styles.css
```

Do not add certificates, private keys, session tokens, local paths, image
assets, prompts, or user content to the plugin ZIP.

## Create ZIP And SHA-256

The full build already runs the packager. Use the command below to rerun only
the repository packager on macOS, Linux, or Windows. Do not replace it with
an ad hoc archive command; it enforces the exact four-file allowlist, Manifest
v5 identity, safe ZIP paths, deterministic timestamps/order, and an exact
three-file output allowlist.

```bash
pnpm release:dev
```

It writes exactly these files:

```text
dist/release/
  cinevfx-photoshop-uxp-dev-preview-0.1.0.zip
  release-manifest.json
  SHA256SUMS.txt
```

`release-manifest.json` records `releaseChannel: "dev-preview"`, the development
plugin id, `photoshopRuntimeVerified: false`, `signed: false`, and
`installer: false`. `SHA256SUMS.txt` covers both the ZIP and release manifest.

Verify on macOS/Linux:

```bash
(cd dist/release && shasum -a 256 -c SHA256SUMS.txt)
unzip -l dist/release/cinevfx-photoshop-uxp-dev-preview-0.1.0.zip
```

Verify independently on Windows PowerShell:

```powershell
$releaseDir = Join-Path $PWD "dist\release"
$manifest = Get-Content `
  (Join-Path $releaseDir "release-manifest.json") -Raw | ConvertFrom-Json
$zip = Join-Path $releaseDir $manifest.artifact.file
$actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
if ($actual -ne $manifest.artifact.sha256) {
  throw "CineVFX release ZIP checksum mismatch"
}
```

The ZIP root must expose `manifest.json`; it must not contain an extra
`plugin/` directory level.

## Start The Local API

The canonical/default endpoint is `https://localhost:8787`. The API fails
closed if its TLS key/certificate pair is missing or incomplete. Generate and
trust a development-only certificate using the platform-specific commands in
[the Mock API README](../apps/api-server/README.md#local-https), then set:

macOS/Linux:

```bash
export CINEVFX_MOCK_TLS_KEY_FILE=/absolute/path/to/mock-key.pem
export CINEVFX_MOCK_TLS_CERT_FILE=/absolute/path/to/mock-cert.pem
pnpm --dir apps/api-server start
```

Windows PowerShell:

```powershell
$env:CINEVFX_MOCK_TLS_KEY_FILE = "$env:LOCALAPPDATA\CineVFX\certs\mock-key.pem"
$env:CINEVFX_MOCK_TLS_CERT_FILE = "$env:LOCALAPPDATA\CineVFX\certs\mock-cert.pem"
pnpm --dir apps/api-server start
```

Trust the certificate only in the current user's trust store, protect the
private key, and remove the trust entry after development. The certificate
must include `localhost` and `127.0.0.1` subject alternative names. Repository
tests verify the Node TLS server; Photoshop/UXP certificate trust remains
**UNVERIFIED**.

Windows may explicitly use development-only loopback HTTP:

```powershell
Remove-Item Env:CINEVFX_MOCK_TLS_KEY_FILE -ErrorAction SilentlyContinue
Remove-Item Env:CINEVFX_MOCK_TLS_CERT_FILE -ErrorAction SilentlyContinue
$env:CINEVFX_MOCK_HOST = "127.0.0.1"
$env:CINEVFX_MOCK_ALLOW_HTTP = "1"
pnpm --dir apps/api-server start
```

Then set the panel API URL to `http://127.0.0.1:8787`. HTTP is never selected
implicitly, and it must not be exposed beyond the local machine.

## Load With UXP Developer Tool

1. Verify the ZIP checksum.
2. Extract it to a new local folder. Do not load directly from the ZIP.
3. Open UXP Developer Tool and connect it to Photoshop 2026 / 27.x.
4. Choose **Add Plugin** and select the extracted `manifest.json`.
5. Choose **Load** or **Reload**.
6. In Photoshop, open **Plugins > CineVFX**.
7. Keep the API URL at `https://localhost:8787`, unless Windows HTTP was
   explicitly enabled as described above.
8. Start the local Mock API before using **Submit job**, **Cancel**, or
   **Plan import** network paths.

The visible workflow uses fixed demo IDs and dimensions. **Plan proxy** creates
metadata only. **Submit job** exercises the local Mock API. **Plan import**
validates and prepares a plan only; it does not place Photoshop layers.

## Acceptance Checklist

Automated delivery checklist:

- [ ] `pnpm check`, `pnpm test`, and `pnpm build` pass
- [ ] UXP `check`, `test`, and `build` pass
- [ ] ZIP contains only the four generated plugin files
- [ ] `release-manifest.json` says unsigned/unverified development preview
- [ ] `SHA256SUMS.txt` and the manifest SHA-256 match the ZIP
- [ ] No certificate, key, token, image, prompt, or user path is packaged
- [ ] Release notes call the artifact a development preview, not a signed CCX

Manual Photoshop checklist, currently **UNVERIFIED**:

- [ ] UDT loads the panel on macOS Photoshop 2026
- [ ] UDT loads the panel on Windows Photoshop 2026
- [ ] HTTPS trust and `/healthz` session bootstrap work in both hosts
- [ ] Real proxy export uses the active document/layer without moving it
- [ ] Real import runs through bounded `executeAsModal`
- [ ] Failure/cancel leaves no partial layer group
- [ ] One undo removes the complete imported result
- [ ] Pixel/transform comparison proves the protected source is unchanged

Do not promote this development ZIP to a formal release until the applicable
manual checklist is complete and a signing/distribution decision is recorded.
