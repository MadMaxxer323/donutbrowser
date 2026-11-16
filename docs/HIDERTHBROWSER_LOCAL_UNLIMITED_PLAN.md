# HiderTHBROWser — Local Unlimited Edition Plan

This branch is the HiderTHBROWser development line for the user's existing Donut Browser fork.

## Product rule

**Local features are available without a Donut subscription, account, or cloud service.** "Unlimited" means no artificial subscription quotas for locally executed features; practical limits still come from memory, CPU, disk, operating-system limits, and configured safety/concurrency controls.

Do not fake a Donut cloud login, synthesize cloud entitlements, or send requests to a service the project does not own. Remove local feature gates by introducing a clearly named local-edition capability provider, and keep cloud-backed operations disabled or visibly unavailable.

## What the fork already contains

The fork is a complete Tauri + Next.js + Rust desktop application, not just a browser shell. It includes:

- A local Wayfern process manager and CDP bridge. For supported Wayfern versions, the code calls `Wayfern.createIdentity` against a locally launched headless browser, then stores/reapplies the returned identity. The manager is in `src-tauri/src/wayfern_manager.rs`.
- A browser-version manager and downloader. Wayfern release metadata is fetched from `https://donutbrowser.com/wayfern.json`; the binary is installed and run locally. The Wayfern binary/source and its separate license are not included as ordinary Rust source in this repository.
- Persistent and ephemeral profiles, import/export, profile groups, bookmarks, extensions, cookie management, site storage, profile passwords, TOTP, and profile cleanup.
- Per-profile proxy and VPN management, proxy rotation, DNS filtering, route checks, and leak checks.
- A local REST API in `src-tauri/src/api_server.rs`.
- A browser-control MCP tool engine in `src-tauri/src/mcp_server.rs`.
- Cookie Bot UI/transport in `src-tauri/src/cookie_bot.rs`, but its current schedule and execution are owned by the Donut cloud API and remote hosts.
- A remote MCP bridge in `src-tauri/src/mcp_remote.rs`; it connects outbound to `api.donutbrowser.com` and is cloud-dependent.
- A cloud entitlement system in `src-tauri/src/cloud_auth.rs` and `src/lib/entitlements.ts`.

## Subscription caps found in the current source

These are upstream product-plan rules, not hard limits imposed by the local browser engine:

- `profile_generation_limiter.rs`: free users receive a soft allowance that shrinks from 8 to 2 profile generations per hour as profile count grows; Solo has a hard cap of 10/hour; Pro/Team/Enterprise have a hard cap of 100/hour. Free also has a 3-running-browser seat limit and Solo 9.
- `automation_rate_limiter.rs` and `cloud_auth.rs`: the local REST/MCP automation limiter uses the account's `requests_per_hour`; the fallback default is 100 requests/hour, not 100 requests/minute.
- Cross-OS fingerprints and browser automation are checked against cloud entitlements.
- Cookie Bot hours and schedules are server-owned and run on remote hosts.
- Remote MCP is a cloud relay. It is not the same thing as local MCP/browser control.

## Local-unlimited implementation policy

### Make unlimited locally available

1. **Profiles and fingerprint generation:** no subscription-based generations/hour cap and no paid-plan browser-seat cap in the local edition. Keep a configurable launch queue and a sensible default concurrency to protect the machine. A user can raise it.
2. **Native identity generation:** expose local Wayfern identity creation for the host OS without plan quotas. A non-native OS identity is still subject to Wayfern's own `wayfernToken` requirement; the current fork obtains that token from the Donut account service. Do not fake a token or claim offline cross-OS identity generation is available.
3. **Local Browser Manipulation API:** keep it bound to loopback by default and available without cloud sign-in. No subscription/hour quota. Retain authentication, request-size limits, concurrency control, and user-configurable rate protection.
4. **Local MCP:** expose the existing browser-control tools through stdio and optionally authenticated loopback Streamable HTTP. No cloud relay required.
5. **Local recipes:** execute saved recipes on this device with visible run state, timeouts, cancellation, and local audit events.
6. **Proxy/VPN/DNS tools:** retain the existing local implementation. Do not couple local proxy setup to cloud proxy inventory.
7. **Local profile backup/synchronizer:** implemented passphrase-encrypted `.hiderbackup` snapshots and restore-as-new-profile in the Rust backend; user-selected destinations and removable drives work without cloud upload. Backup rotation and scheduled synchronization remain future work.
8. **Local audit log:** searchable and exportable. Redact credentials, cookies, authorization headers, and page content.

### Replace cloud-only services with honest local equivalents

| Upstream feature | Local HiderTHBROWser treatment |
|---|---|
| Cloud profile backups / cloud sync | Encrypted local snapshots and manual folder/removable-drive transfer |
| Encrypted local profile backup/restore | Implemented in the Rust backend and Profile Transfer UI; native CI validation pending |
| Remote MCP relay | Local stdio MCP and optional authenticated loopback MCP |
| Cookie Bot remote hours/schedule | Local scheduler for user-authorized browser QA workflows; no remote-host hours or cloud claims |
| Remote browser execution hours | Run locally while this computer is on; resource controls are local |
| Team profile sharing | Password-encrypted profile packages that users transfer themselves |
| SSO | Not applicable to a standalone offline desktop; optional local OS account/keystore protection instead |
| Email/Slack/priority support and custom SLA | Support/business services, not app features; omit from the local product |
| Commercial use | Preserve AGPL-3.0 obligations and all third-party license terms |

### Explicitly exclude

- Donut hosted API, account/subscription claims, cloud sync/backup, cloud Cookie Bot execution, cloud remote MCP relay, and any code that pretends those external services are locally available.
- Claims that a random User-Agent or isolated cookie jar is a native fingerprint. Only the Wayfern engine's local identity APIs can provide the fingerprint features it actually supports.
- Unlimited network exposure. The API/MCP should remain local by default and require explicit opt-in for any LAN listener.

## Recommended new features, in priority order

1. **One-screen Batch Launcher:** URL + profile count + profile template + optional proxy assignment + launch queue; save reusable launch sets.
2. **Encrypted Local Backup/Restore:** full profile data snapshots with AES-GCM, passphrase-based key derivation, integrity verification, backup rotation, and a restore preview. Never include secrets in plain JSON.
3. **Local MCP Agent Mode:** stdio first; tools for profiles, launch sets, navigation, screenshots, tabs, cookie consent, and recipes. Every write/destructive action should require explicit tool invocation and be audited.
4. **Proxy Health Center:** per-profile proxy test, exit-IP display, DNS/WebRTC leak diagnostics, latency history, and clear warnings when the route differs from the fingerprint's location.
5. **Local Automation Scheduler:** schedules run only while the desktop is available; support site checks and workflows against domains/accounts the user controls, with visible progress, timeouts, retry policy, and a stop-all control. This is for authorized QA and personal workflows, not artificial engagement or evasion of anti-abuse systems.
6. **Profile Template Library:** reusable OS/browser/screen/language/timezone templates with compatibility validation and clear identity provenance.
7. **Session Health Dashboard:** per-profile process state, memory/CPU, open tabs, proxy health, recent errors, and a one-click safe close.
8. **Release engineering:** CI for Rust/TypeScript tests, signed release artifacts where signing credentials exist, SBOM/license manifest, checksums, and rollback-capable updates.

## Safety and reliability rules

"Unlimited" is not a promise to overwhelm a computer or a website. Keep bounded batch sizes, user-configurable concurrency, per-task timeouts, visible cancellation, and local resource warnings. Do not add stealth behaviours designed to defeat a website's anti-abuse controls, manufacture engagement, or bypass access restrictions. Browser automation should be for personal workflows, owned properties, and authorized QA.

## Licensing and rebrand

The source fork is AGPL-3.0. Rebranding and distributing a modified version must preserve the AGPL notice and comply with source-offer/source-disclosure requirements. Check the separate Wayfern binary and every bundled third-party component's license before redistributing them. Do not assume the Donut name, logo, or trademarks are included in the code license.

## Immediate build sequence

1. Establish a Hider local-edition capability/config layer; keep cloud entitlements out of local feature paths.
2. Remove the local profile-generation and running-seat subscription caps; replace with a local queue and user-set concurrency.
3. Make the local REST API and MCP tools available without an account while keeping loopback authentication and rate protection.
4. Hide/disable cloud-only screens and remove automatic calls to Donut hosted services from the offline build.
5. Verify encrypted local profile backup/restore on Windows and Linux; implement the local automation scheduler.
6. Rebrand the Tauri app, identifiers, updater, icons, docs, installer names, and package metadata.
7. Run Rust tests, frontend checks, Windows/macOS/Linux CI, then publish installers.

## Windows and Linux build pipeline

The local branch has a GitHub Actions workflow at `.github/workflows/hider-platform-builds.yml` that builds on native hosted runners whenever this branch is updated, and can also be started manually.

- **Windows 10/11 x64:** Tauri NSIS installer (`.exe`).
- **Linux x64:** Debian package (`.deb`), RPM package (`.rpm`), and portable AppImage.
- The workflow uploads platform artifacts for 14 days. These are CI test artifacts, not signed public releases.
- The Linux build requires the WebKitGTK 4.1, GTK, Ayatana app-indicator, XDO, RPM, and AppImage/FUSE build dependencies.
- This is not a macOS build pipeline. Native Windows/Linux build jobs are the source of truth for platform compilation; a Linux-only developer environment cannot verify the Windows installer.

## Local edition network boundary

When the `hider-local-unlimited` Cargo feature is enabled, startup does not launch Donut cloud token/profile refresh, cloud proxy sync, remote-session streaming, cloud Cookie Bot scheduling/exit monitoring/reporting, or the remote MCP bridge. The on-device MCP server and loopback API remain local features. Self-hosted sync is a separate feature and must be tested against its own server configuration; this network boundary does not make the rest of the application universally offline (browser downloads, geolocation databases, and public proxy checks may still access their configured providers).

An earlier Linux x64 DEB/AppImage-only build completed successfully on GitHub Actions. The current matrix also requests an RPM package. Linux runs the complete Biome and TypeScript checks; Windows runs the TypeScript check and compiles on its native runner. Treat each output as verified only when its own native runner has completed and uploaded it; do not describe installers as production-ready until generated packages have been smoke-tested on target systems.

## Important repository note

The user's fork currently lives at `MadMaxxer323/donutbrowser` and is a public fork of `donutbrowser/donutbrowser`. The separate `MadMaxxer323/HiderTHBROWser` repository created earlier contains only the small Electron prototype. The production codebase should be the fork; do not try to rebuild 1,000+ source files by copying them individually into the prototype repository.
