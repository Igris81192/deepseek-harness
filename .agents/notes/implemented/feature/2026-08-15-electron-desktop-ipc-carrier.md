# Agent Note: Electron desktop app with an IPC-carried web client

Status: implemented

English | [中文](2026-08-15-electron-desktop-ipc-carrier.zh.md)

## Problem

DeepSeek Harness had no desktop client. The `dsh web` profile served a browser client over the webserver; headless and ACP covered automation. The repo reserved a desktop architecture but never assembled one: the [gui-layering Agent Note](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md) names a future Electron application that "reuses the same web client packages over an IPC fetch carrier", and `dsh-client-connection` exposes the transport-selection seam, yet no process hosted the web profile next to the product UI, and no carrier existed for the renderer to reach it.

## Decision

**New `apps/desktop` package (`@deepseek-ai/dsh-desktop`).** The Electron main process boots the full `web` profile in-process with `runProfile`, holds the host Context merges (`ctx.apiProxy`, `ctx.clientModules`) itself, and serves the API, boot graph, and plugin bundles to a `file://` renderer over four IPC bridges whose message shapes live in `src/bridge.ts`. **v1 keeps the webserver mounted** — the network path stays, bound to a loopback-only, trusted-guarded, OS-assigned port (the desktop requests `--port 0`, so a concurrently running `dsh web` cannot block the boot); removing the socket entirely is Phase 2 ([Deferred](#deferred)). The renderer is a client-plane program (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`); only the preload (`src/preload.cjs`) exposes `window.__dshDesktop`, the single bridge surface.

**Transport: `ElectronApiClient extends AbstractApiClient`** (following `WebApiClient`/`InProcessApiClient`), so the carrier implements only `doFetch`: unary/respond legs POST over the bridge; the two events paths (`MUX_EVENTS_PATH`/`HOST_EVENTS_PATH`) open a push stream the renderer re-frames as the exact `data: {json}\n\n` SSE chunks the inherited `readSse` consumes. The main process serves the unary/respond legs with `ctx.connection.createApiFetchHandler()` — the composed `/api` dispatcher the web HTTP bridge mounts — and builds each request against a loopback authority with an explicit loopback Host header, so the in-process renderer is classified loopback exactly like a browser tab at `127.0.0.1`: the generic RPC channels the surface plugins call (`dynamicCordisRunner`) route, and the loopback-pinned settings/credentials/host methods stay reachable. `InProcessApiClient` exercises the same api-proxy protocol in-process, so the IPC round trip is validated against the real wire shapes, not a re-implementation. Response bodies round-trip as base64 (main `Buffer.toString('base64')` → renderer `atob` decode in `src/base64.ts`) because `session.export` can be binary.

**Streams.** Renderer `openStream(streamId, path)` → main iterates `ctx.apiProxy.events.mux`/`host` and forwards each frame as `ServerRequest` over `webContents.send`; a mid-stream failure emits one `stream/error` frame then end (the client must see the failure, not a silent close), and closing aborts the pump's `AbortController` and removes the stream.

**Plugin bundles and boot.** `loadBundle(url)` decodes the plugin id with `bundleIdFor(url)` (`/plugins/<id>/client.js?rev=…`), fetches the JS text over `readBundle` (`ctx.clientModules.clientPath` → `readFile`), and runs it as a classic script. The renderer fetches `bootManifest()` (`ctx.clientModules.graph()`) into `window.__DSH_BOOT__` before `AppWebEntry.run()`, mirroring the web host's HTML injection.

**Packaged boot.** The packaged `.app` boots the web profile against its own `node_modules`: `main.ts` passes `bareModuleBaseUrl` when `app.isPackaged`, and the bundle ships unpacked (`asar: false` in `electron-builder.yml`) — Electron's Node cannot traverse the `~/.dsh/profiles/node_modules` symlinks into an asar (realpath of an asar target fails with ENOTDIR), so node_modules must be a real directory for the same symlink walk to work. The app's `dependencies` declare the full host surface directly — service definitions and peers such as `@deepseek-ai/cordis-plugin-group` and `@deepseek-ai/dsh-invariants` that the app closure otherwise misses — because electron-builder packs only the declared dependency graph. `main.ts` also supplies `process.argv[1]` when a Finder launch passes none: the watch-only HMR instance profile-boot mounts on long-lived surfaces resolves it to track reload dependencies.

**`dsh-client-connection` ships two changes.** The host face extracts the composed `/api` dispatcher from `apply`'s inline closure into `HostConnectionService.createApiFetchHandler()` — a transport-independent `FetchHandler` (exposed on `HostConnectionHandle`) that the webserver's `/api` route and any future adapter share: generic RPC-channel interception, then the privileged-method loopback pin, the events upgrade fence, and the API Proxy fallback. The desktop main is a first consumer: `main.ts` serves the IPC fetch channel with `createApiFetchHandler()` and builds each request against `127.0.0.1` with an explicit loopback Host header. The renderer is the trusted in-process UI, classified loopback exactly like a browser tab at `127.0.0.1`, so the generic RPC channels route and the pinned settings/credentials/`host.openPath` methods stay reachable; `main.ts` still rejects the events paths on the fetch channel (the upgrade fence would answer them 426, and the explicit rejection reads clearer). The client face swaps the transport: `apply` now reads `globalThis.__DSH_DESKTOP_TRANSPORT__` and prefers `desktop.createApi()`/`createRpc()` over `new WebApiClient()`/`createWebConnectionRpc()`, mirroring the existing `?fixture` selection; a desktop shell sets `isLoopback` true regardless of page authority (a `file://` page is otherwise classified non-loopback). The seam lives on the shell's side — connection never depends on the app, and non-desktop browsers are untouched.

## Testing

The carrier tests (`apps/desktop/tests/carrier.host.spec.ts`) drive `ElectronApiClient` and `createDesktopConnectionRpc` against `fakeDesktopBridge`, an in-memory twin of the main-process handlers that composes the real `/api` dispatcher (`HostConnectionService.createApiFetchHandler`) over the scripted api and builds requests with the same loopback Host header as `main.ts`, then assert differential equality against the reference `InProcessApiClient` — unary (including a loopback-privileged method), both event streams, mid-stream failure, cancellation, and generic RPC including target rejection. The desktop-transport branch of `dsh-client-connection` was already covered by the existing client-apply spec. No new snapshot: the assembled app transcript is unchanged for the model, so the web snapshots continue to pin it.

## Deferred

Zero-port: make `dsh-client-modules`' `inject: ['webServer', 'loader']` and its `/plugins` route/tapIndex tolerate a missing `webServer`, and give `dsh-web-app` a desktop runtime line that omits `FrontendStatic`, so the desktop host binds no socket at all.

## Alternatives considered

**Renderer loads the webserver URL (`http://localhost`) instead of `file://` + IPC.** Rejected: it keeps the renderer's transport dependent on the network path and port allocation, and the gui-layering note already scoped Electron to an IPC carrier, not the webserver. The webserver still mounts in v1 for compatibility, but the renderer never talks to it.

**Zero-port from the start.** Rejected for v1 to bound blast radius: dropping the webserver touches `dsh-client-modules` and `dsh-web-app` and wants its own verification; v1 keeps the network path and defers the cleanup ([Deferred](#deferred)).

**Hardcoding the Electron carrier into `dsh-client-connection`.** Rejected: the client package must stay app-agnostic and dependency-free of the app; the injected `__DSH_DESKTOP_TRANSPORT__` provider is the same shape as the `?fixture` selection and keeps the seam external.

**Renderer with `nodeIntegration: true` / a node-exposing preload.** Rejected: the sandboxed `contextBridge` surface is the entire trust boundary of the page; anything beyond the four bridges would widen the renderer's authority against the host process.

## Consequences

The repo now ships a local, double-clickable macOS `.app` (electron-builder `dir` target, `identity: null` — unsigned and unnotarized, so macOS Gatekeeper requires right-click Open). Host and renderer share one process, so the product UI no longer depends on a loopback HTTP round trip; the client packages stay app-agnostic (one seam, one changed apply). The cost is the retained webserver socket in v1, the unsigned binary, a renderer bundle that must be built before running (`desktop:build`), and one extra framing hop per stream versus an in-process carrier.
