# Agent Note: 基于 IPC 载体承载 Web 客户端的 Electron 桌面版

Status: implemented

[English](2026-08-15-electron-desktop-ipc-carrier.md) | 中文

## 问题

DeepSeek Harness 没有桌面客户端。`dsh web` profile 通过 webserver 向浏览器客户端提供服务；headless 与 ACP 覆盖自动化场景。仓库预留了桌面架构但从未组装：[GUI 分层 Agent Note](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md) 指明未来的 Electron 应用「复用同一套 web client 包，通过 IPC fetch carrier 承载」，`dsh-client-connection` 也暴露了 transport 选择 seam，然而没有任何进程把 web profile 与产品 UI 放在一起，也不存在让渲染进程触达它的 carrier。

## 决策

**新增 `apps/desktop` 包（`@deepseek-ai/dsh-desktop`）。** Electron 主进程通过 `runProfile` 在进程内完整 boot `web` profile，由它自己持有 Host Context 合并（`ctx.apiProxy`、`ctx.clientModules`），并把 API、boot 图与插件 bundle 通过四条 IPC 桥（消息形状定义在 `src/bridge.ts`）提供给 `file://` 渲染进程。**v1 保留 webserver**——网络路径仍在，绑定到仅回环、带信任护栏、由 OS 分配的端口（桌面请求 `--port 0`，因此并发的 `dsh web` 不会阻塞启动）；彻底移除 socket 是 Phase 2（[延后](#deferred)）。渲染进程是 client-plane 程序（`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`）；只有 preload（`src/preload.cjs`）暴露 `window.__dshDesktop` 这唯一的桥接面。

**Transport：`ElectronApiClient extends AbstractApiClient`**（对照 `WebApiClient`/`InProcessApiClient`），因此 carrier 只需实现 `doFetch`：unary/respond 段通过桥 POST；两个事件路径（`MUX_EVENTS_PATH`/`HOST_EVENTS_PATH`）打开一个推送流，渲染进程把它重排成继承的 `readSse` 消费所需的 `data: {json}\n\n` SSE 分片。主进程用 `ctx.connection.createApiFetchHandler()`（web HTTP 桥挂载的组合式 `/api` 分发器）服务 unary/respond 段，并针对回环权威、携带显式回环 Host 头构造每个请求，使进程内渲染进程与 `127.0.0.1` 的浏览器标签页同属回环信任类：surface 插件调用的通用 RPC 通道（`dynamicCordisRunner`）得以路由，被固定到回环的 settings/credentials/host 方法也保持可达。`InProcessApiClient` 进程内走的是同一 api-proxy 协议，因此 IPC 往返针对真实线上线形态校验，而不是重新实现一套。响应体以 base64 往返（主进程 `Buffer.toString('base64')` → 渲染进程在 `src/base64.ts` 用 `atob` 解码），因为 `session.export` 可能是二进制。

**流。** 渲染进程 `openStream(streamId, path)` → 主进程迭代 `ctx.apiProxy.events.mux`/`host`，把每一帧作为 `ServerRequest` 经 `webContents.send` 转发；中途失败先发一个 `stream/error` 帧再结束（客户端必须看到失败而不是静默关闭），关闭时中止 pump 的 `AbortController` 并移除该流。

**插件 bundle 与 boot。** `loadBundle(url)` 用 `bundleIdFor(url)` 解码插件 id（`/plugins/<id>/client.js?rev=…`），经 `readBundle`（`ctx.clientModules.clientPath` → `readFile`）取回 JS 文本，并以 classic script 执行。渲染进程在 `AppWebEntry.run()` 之前把 `bootManifest()`（`ctx.clientModules.graph()`）取回写入 `window.__DSH_BOOT__`，镜像 web 宿主在 HTML 中的注入。

**`dsh-client-connection` 随本次改动交付两处变更。** Host 面把 `apply` 内联闭包中的组合式 `/api` 分发器提取为 `HostConnectionService.createApiFetchHandler()`——一个 transport 无关的 `FetchHandler`（暴露在 `HostConnectionHandle` 上），由 webserver 的 `/api` 路由与任何未来的适配器共享：先是通用 RPC 通道拦截，再是特权方法回环固定、事件升级围栏、API Proxy 回退。桌面主进程是它的第一个消费者：`main.ts` 用 `createApiFetchHandler()` 服务 IPC fetch 通道，并针对 `127.0.0.1`、携带显式回环 Host 头构造每个请求。渲染进程是可信的进程内 UI，与 `127.0.0.1` 的浏览器标签页同属回环信任类，因此通用 RPC 通道得以路由，被固定的 settings/credentials/`host.openPath` 方法保持可达；`main.ts` 仍在 fetch 通道上拒绝事件路径（升级围栏会以 426 应答，显式拒绝读起来更清晰）。Client 面交换 transport：`apply` 现在读取 `globalThis.__DSH_DESKTOP_TRANSPORT__`，优先使用 `desktop.createApi()`/`createRpc()`，其次才是 `new WebApiClient()`/`createWebConnectionRpc()`——与既有 `?fixture` 选择同构；桌面 shell 无论页面权威如何都把 `isLoopback` 置为 true（否则 `file://` 页面会被归类为非回环）。seam 位于 shell 一侧——connection 从不依赖 app，非桌面浏览器不受影响。

## 测试

carrier 测试（`apps/desktop/tests/carrier.host.spec.ts`）把 `ElectronApiClient` 与 `createDesktopConnectionRpc` 对 `fakeDesktopBridge` 驱动——后者是主进程 handler 的内存孪生，在脚本化 api 之上组合真实的 `/api` 分发器（`HostConnectionService.createApiFetchHandler`），并用与 `main.ts` 相同的回环 Host 头构造请求——并断言与参照 `InProcessApiClient` 的差分一致性：unary（含一个回环特权方法）、两个事件流、流中途失败、取消，以及含目标拒绝在内的通用 RPC。`dsh-client-connection` 的桌面 transport 分支已由既有的 client-apply spec 覆盖。不新增快照：组装后应用的模型可见 transcript 未变，web 快照继续钉住它。

<a id="deferred"></a>

## 延后

零端口：让 `dsh-client-modules` 的 `inject: ['webServer', 'loader']` 及其 `/plugins` 路由/tapIndex 容忍缺失的 `webServer`，并给 `dsh-web-app` 增加一条不挂 `FrontendStatic` 的桌面 runtime 行，使桌面宿主完全不绑定 socket。

## 曾考虑的替代方案

**渲染进程加载 webserver URL（`http://localhost`）而非 `file://` + IPC。** 不采用：渲染进程的 transport 会继续依赖网络路径与端口分配，且 GUI 分层 note 已把 Electron 限定为 IPC carrier，而非 webserver。v1 出于兼容仍挂载 webserver，但渲染进程从不与它通信。

**从第一步就做零端口。** v1 不采用，以限定影响面：去掉 webserver 会触及 `dsh-client-modules` 与 `dsh-web-app`，且需要独立的验证；v1 保留网络路径，把清理延后（[延后](#deferred)）。

**把 Electron carrier 硬编码进 `dsh-client-connection`。** 不采用：客户端包必须保持 app 无关、不反向依赖 app；注入的 `__DSH_DESKTOP_TRANSPORT__` provider 与 `?fixture` 选择同形，把 seam 留在外部。

**渲染进程开 `nodeIntegration: true` / 暴露 node 的 preload。** 不采用：沙箱化的 `contextBridge` 面是页面唯一的信任边界；任何超出四条桥的能力都会扩大渲染进程对主进程的权威。

## 后果

仓库现在交付一个本地、可双击运行的 macOS `.app`（electron-builder `dir` target，`identity: null`——未签名、未公证，因此 macOS Gatekeeper 需要右键「打开」）。宿主与渲染进程共用一个进程，产品 UI 不再依赖回环 HTTP 往返；客户端包保持 app 无关（一处 seam、一处改动的 apply）。代价是 v1 保留的 webserver socket、未签名的二进制、运行前必须构建的渲染 bundle（`desktop:build`），以及相比进程内 carrier 每条流多一跳的组帧开销。
