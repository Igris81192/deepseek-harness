# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

dsh 的 macOS 桌面版。Electron 主进程通过 `runProfile` 在进程内 boot `web` profile，并把它的 API、boot 图与插件 bundle 经 [`src/bridge.ts`](src/bridge.ts) 中的 IPC 桥提供给 `file://` 渲染进程；渲染进程运行的是与浏览器客户端相同的 `@deepseek-ai/dsh-client-web` 入口，只是 transport 换成了 IPC。设计与取舍见 [Agent Note](../../.agents/notes/implemented/feature/2026-08-15-electron-desktop-ipc-carrier.md)。

## 运行

从仓库根目录构建一次后启动：

```sh
pnpm run desktop:build    # main + preload (tsdown) and the renderer bundle (vite)
pnpm run desktop:dev      # desktop:build then `electron .`
```

启动前必须先构建渲染 bundle——Electron 经 `file://` 加载 `dist/index.html`。宿主 boot 的 `web` profile 与浏览器客户端相同，因此应用对着同一份 `$DSH_HOME` 数据镜像 `dsh web` 的行为。该 profile 会在 `@deepseek-ai/dsh-web-frontend/dist/index.html` 解析已构建的浏览器客户端，所以也要先构建它：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend build    # the web profile's frontend dist
```

缺少时启动会大声失败（`web-app: frontend dist not built`）。

## 打包

```sh
pnpm run desktop:dist     # desktop:build then electron-builder --mac dir
```

`electron-builder.yml` 以 `identity: null` 构建 `dir` 形态，因此 `apps/desktop/release/` 下的产物是仅本地、未签名的 `.app`——macOS Gatekeeper 首次启动需要右键 →「打开」。打包载荷与发布包一致：构建出的主进程、preload 与渲染 bundle。

## 已知限制

- **v1 保留 webserver。** `web` profile 仍然绑定仅回环、带信任护栏、由 OS 分配的端口（桌面请求 `--port 0`，因此并发的 `dsh web` 不会阻塞启动），尽管渲染进程从不与它通信；彻底移除 socket 是[零端口 Phase 2](../../.agents/notes/implemented/feature/2026-08-15-electron-desktop-ipc-carrier.md#deferred)。
- **未签名、未公证。** 分发为手动进行；没有代码签名或公证流水线。
- **仅 macOS 打包。** Electron 本身跨平台，但 `electron-builder.yml` 只配置了 mac `dir` target。
