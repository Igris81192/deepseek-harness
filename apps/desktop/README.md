# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

The dsh macOS desktop app. An Electron main process boots the `web` profile in-process (`runProfile`) and carries its API, boot graph, and plugin bundles to a `file://` renderer over the IPC bridges in [`src/bridge.ts`](src/bridge.ts); the renderer is the same `@deepseek-ai/dsh-client-web` entry the browser client runs, with the transport swapped for IPC. Design and trade-offs live in the [Agent Note](../../.agents/notes/implemented/feature/2026-08-15-electron-desktop-ipc-carrier.md).

## Run

From the repository root, build once and launch:

```sh
pnpm run desktop:build    # main + preload (tsdown) and the renderer bundle (vite)
pnpm run desktop:dev      # desktop:build then `electron .`
```

The renderer bundle is required before launch — Electron loads `dist/index.html` over `file://`. The host boots the same `web` profile the browser client uses, so the app mirrors `dsh web` behavior against the same `$DSH_HOME` data. That profile resolves the built browser client at `@deepseek-ai/dsh-web-frontend/dist/index.html`, so build it once too:

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend build    # the web profile's frontend dist
```

The boot fails loudly without it (`web-app: frontend dist not built`).

## Package

```sh
pnpm run desktop:dist     # desktop:build then electron-builder --mac dir
```

`electron-builder.yml` targets the `dir` form with `identity: null`, so the output in `apps/desktop/release/` is a local-only, unsigned `.app` — macOS Gatekeeper requires right-click → Open on first launch. The packaged payload mirrors the published package: the built main, the preload, and the renderer bundle.

## Known limitations

- **v1 keeps the webserver mounted.** The `web` profile binds a loopback-only, trusted-guarded, OS-assigned port (the desktop requests `--port 0`, so a concurrently running `dsh web` cannot block the boot) even though the renderer never talks to it; removing the socket entirely is [zero-port Phase 2](../../.agents/notes/implemented/feature/2026-08-15-electron-desktop-ipc-carrier.md#deferred).
- **Unsigned and unnotarized.** Distribution is manual; there is no codesigning or notarization pipeline.
- **macOS packaging only.** Electron itself is cross-platform, but `electron-builder.yml` configures only the mac `dir` target.
