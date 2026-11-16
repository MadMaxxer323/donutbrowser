# HiderTHBROWser

**Local-first multi-profile desktop browser for Windows 10/11 and Linux.**

This repository is the HiderTHBROWser development fork of Donut Browser. It retains the upstream Tauri + Next.js + Rust architecture and its Wayfern engine integration. Hider-specific local-edition changes are developed on the `hiderthbrowser-local` branch.

> **Important:** HiderTHBROWser is not yet a completed or verified release. The Windows and Linux build workflow is being added; installer artifacts become available only after GitHub Actions finishes successfully.

## Platform targets

| Platform | Package target | Build status |
|---|---|---|
| Windows 10/11 x64 | NSIS `.exe` installer | CI workflow added; build result pending |
| Linux x64 (Debian/Ubuntu) | `.deb` | CI workflow added; build result pending |
| Linux x64 (general desktop) | AppImage | CI workflow added; build result pending |
| Linux ARM64 | Not in this initial workflow | Not yet configured |
| macOS | Not in this initial workflow | Not currently targeted |

### Get build artifacts

Every push to `hiderthbrowser-local` triggers the **HiderTHBROWser Windows and Linux Builds** workflow.

1. Open the [Actions tab](https://github.com/MadMaxxer323/donutbrowser/actions/workflows/hider-platform-builds.yml).
2. Open the newest successful run.
3. Download `HiderTHBROWser-Windows-x64` for the Windows installer, or `HiderTHBROWser-Linux-x64` for the Linux `.deb` and AppImage packages.

CI artifacts are temporary and are retained for 14 days. They are not signed release downloads.

## Current local-edition direction

The default Cargo feature `hider-local-unlimited` is enabled in this branch. It removes subscription-based caps on local profile generation, concurrent browser seats, and local REST/MCP automation requests.

"Unlimited" here means **no Hider subscription quota on local operations**. Real usage remains bounded by the computer's RAM, CPU, disk space, browser-engine support, and operating-system limits. The API remains authenticated and bound to loopback; resource protection and input validation must not be removed.

### Local features inherited from the upstream codebase

- Wayfern Chromium browser management and local CDP integration.
- Local browser profiles, profile groups, import/export, and persistent browser data.
- Per-profile fingerprint configuration and the engine's local identity APIs where supported.
- HTTP, HTTPS, SOCKS4, SOCKS5, and WireGuard profile routing functionality inherited from upstream.
- Local REST API on `127.0.0.1:10108`.
- Browser-control MCP tool engine, exposed locally through the authenticated loopback API and a stdio adapter for AI clients.
- Cookie and extension management, DNS filtering, bookmarks, and profile utilities.

Availability of a feature in source code does not by itself mean it has been tested or that all upstream service integrations work in this local edition.

## Local MCP for AI agents

The full browser-control MCP engine is available without the Donut cloud relay:

- The desktop serves MCP JSON-RPC at `http://127.0.0.1:10108/v1/mcp` through the existing local API server.
- The endpoint uses the same bearer token as the REST API and is bound to loopback only.
- `scripts/hider-mcp-stdio.mjs` bridges newline-delimited MCP stdio messages to that local endpoint. No remote server or cloud account is needed.
- The local tool list excludes cloud-hosted Cookie Bot, remote browser sessions, and team-lock services that have no local implementation.

Configure an MCP client to launch:

```json
{
  "mcpServers": {
    "hiderthbrowser": {
      "command": "node",
      "args": ["/absolute/path/to/donutbrowser/scripts/hider-mcp-stdio.mjs"],
      "env": {
        "HIDER_API_TOKEN": "YOUR_LOCAL_API_TOKEN",
        "HIDER_API_URL": "http://127.0.0.1:10108"
      }
    }
  }
}
```

Replace the path and token with your local values. The API token is shown in the app's API settings. Keep it private. Start HiderTHBROWser before starting the MCP client; the desktop must be running for its local browser tools to work.

Run it manually:

```bash
HIDER_API_TOKEN=YOUR_LOCAL_API_TOKEN pnpm mcp:stdio
```

Windows PowerShell:

```powershell
$env:HIDER_API_TOKEN="YOUR_LOCAL_API_TOKEN"
$env:HIDER_API_URL="http://127.0.0.1:10108"
pnpm mcp:stdio
```

The stdio adapter writes only MCP responses to stdout; diagnostics go to stderr.

## Cloud-dependent features deliberately excluded from the local edition

- Donut cloud backup and cloud profile synchronization.
- Donut-hosted remote MCP relay and remote browser execution.
- The upstream Cookie Bot schedule and remote execution service.
- Team collaboration, SSO, hosted support, cloud hours, and subscription-plan services.

The upstream Cookie Bot source states that its schedules and actual runs are owned by the Donut cloud API and remote hosts. This branch does not pretend that remote service is available offline. A separate local scheduler or local cookie-consent/QA workflow can be implemented as a replacement.

Wayfern's same-device identity generation is performed by the local browser engine. The upstream code also documents that cross-OS identity generation may require a Wayfern token obtained from the Donut account service. HiderTHBROWser does not fake or bypass that authorization; cross-OS identity generation remains unavailable until a separately authorized local engine option exists.

## Build from source

### Requirements

- Windows 10/11 x64 or Linux x64 (Debian/Ubuntu dependencies are used by CI).
- Node.js version specified in `.node-version`.
- pnpm and the stable Rust toolchain.
- Platform build prerequisites for Tauri 2 and WebKitGTK on Linux.

### Install dependencies

```bash
pnpm install --frozen-lockfile
```

### Windows installer

Run in PowerShell or a Windows developer terminal:

```powershell
pnpm tauri build --bundles nsis
```

The NSIS installer is written under:

```text
src-tauri/target/release/bundle/nsis/
```

### Linux DEB and AppImage

Install the Tauri/WebKitGTK development libraries required by the Linux build, then run:

```bash
pnpm test:appimage-metainfo
pnpm tauri build --bundles deb,appimage
```

Packages are written under:

```text
src-tauri/target/release/bundle/deb/
src-tauri/target/release/bundle/appimage/
```

The AppImage can require FUSE 2 compatibility on some distributions. If needed, try:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./HiderTHBROWser_*.AppImage
```

## Local edition implementation status

| Capability | Status |
|---|---|
| Subscription-free local profile generation | Implemented in local-edition build path; CI validation pending |
| Remove subscription-based running-browser seat limit | Implemented in local-edition build path; CI validation pending |
| Local REST/MCP automation without a paid account | Entitlement and quota paths changed; end-to-end validation pending |
| Local Wayfern browser engine integration | Present from upstream; runtime download/platform verification pending |
| Cross-OS identity without Wayfern token | Not available |
| Cloud profile backup and sync | Excluded |
| Cloud Cookie Bot schedule/remote execution | Excluded |
| Local Cookie Bot replacement scheduler | Planned |
| Encrypted local full-profile backup/restore | Planned |
| Local authenticated MCP endpoint | Implemented in development branch; build validation pending |
| MCP stdio adapter for local AI clients | Implemented in development branch; protocol testing pending |
| Windows installer | Workflow added; build pending |
| Linux DEB and AppImage | Workflow added; build pending |

## License and third-party components

This repository is derived from Donut Browser and remains under the upstream **GNU Affero General Public License v3.0 (AGPL-3.0)**. Do not remove upstream copyright notices or relicense the complete derivative as MIT. Any redistribution of modified binaries or network-accessible modified versions must comply with the AGPL and include corresponding source as required.

Wayfern, Xray-core, Tauri, and other bundled components have their own licenses and distribution conditions. Verify those terms before publishing installers. The HiderTHBROWser name and branding do not grant rights to third-party trademarks.
