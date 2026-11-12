# agentene-browser

**单个 Docker 容器,同时提供 Chrome for Testing 浏览器、可实时观看的远程桌面、以及对外暴露的 CDP 端点。**

[![ci](https://github.com/agentene/browser/actions/workflows/ci.yaml/badge.svg)](https://github.com/agentene/browser/actions/workflows/ci.yaml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![docker image size](https://img.shields.io/docker/image-size/agentene/browser)](https://hub.docker.com/r/agentene/browser)
[![docker pulls](https://img.shields.io/docker/pulls/agentene/browser)](https://hub.docker.com/r/agentene/browser)

[English](README.md) | [简体中文](README.zh-CN.md)

容器在一个入口脚本里拉起全部服务,并作为 PID 1 监管它们:

```
docker run ─┬─ labwc       虚拟 Wayland 桌面(Selkies 采集的画面;DISPLAY_BACKEND=x11 时为 Xvfb)
            ├─ PulseAudio  虚拟音频
            ├─ Selkies     HTML5 远程桌面        ─┐
            ├─ Chrome      for Testing,CDP ───────┼─ nginx 统一门面
            └─ nginx      一个进程,3 个端口     ─┘
```

* **带公开 CDP 端点的 Chromium** — 在容器*外部*用 `connectOverCDP("http://localhost:9222")` 接入 [Playwright](https://playwright.dev) / Puppeteer / Selenium。
* **可实时观看的桌面** — 浏览器默认以**有头模式**运行在无头 Wayland 桌面([labwc](https://labwc.github.io/))上(`DISPLAY_BACKEND=x11` 时为 Xvfb/X11),[Selkies](https://github.com/selkies-project/selkies) 2.x 经 WebSocket/WebCodecs 把画面(含音频)串流到任意浏览器(WebRTC 可选)。自动化过程实时可见、可交互。
* **持久化配置目录** — 通过 bind mount,cookies、登录态、扩展在容器重建后依然保留。
* **支持 HTTPS** — 默认自动生成自签证书,也可挂载自己的证书;已存在的有效证书永远优先复用。
* **合理的默认值** — UTC 时区、`en-US` 浏览器语言;两者都是一行环境变量即可覆盖。

## 目录

- [镜像里有什么](#镜像里有什么)
- [快速开始](#快速开始)
  - [Docker Compose](#docker-compose-1)
  - [纯 docker run](#纯-docker-run)
- [端口](#端口)
- [通过 CDP 接入 Playwright](#通过-cdp-接入-playwright)
- [CDP 网关(带登录态的隔离 context)](#cdp-网关带登录态的隔离-context)
- [观看桌面](#观看桌面)
- [登录与 CDP API Key](#登录与-cdp-api-key)
- [配置](#配置)
  - [构建参数](#构建参数)
  - [环境变量](#环境变量)
  - [权限降级(`RUN_USER`)](#权限降级run_user)
  - [时区与语言](#时区与语言)
- [HTTPS](#https-1)
- [GPU 直通(可选)](#gpu-直通可选)
  - [Wayland 桌面(`DISPLAY_BACKEND=wayland`)](#wayland-桌面display_backendwayland)
- [持久化](#持久化)
- [服务开关、健康检查与重启](#服务开关健康检查与重启)
- [从源码构建](#从源码构建)
- [版本联动脚本](#版本联动脚本)
- [CI/CD 与发布的镜像](#cicd-与发布的镜像)
- [安全注意事项](#安全注意事项)
- [故障排查](#故障排查)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 镜像里有什么

| 组件                | 版本                         | 作用                                                              |
| ------------------- | ---------------------------- | ----------------------------------------------------------------- |
| Ubuntu              | 26.04                        | 基础镜像                                                          |
| Node.js             | [钉住的 LTS](Dockerfile)     | 运行 CDP 网关(最新 LTS 主版本)                                    |
| Chrome for Testing  | [钉住的稳定版](Dockerfile)   | 被自动化的浏览器,Google 官方 Stable 通道构建                      |
| Selkies             | [钉住的 release](Dockerfile) | HTML5 远程桌面(Web 客户端、信令、串流)                            |
| nginx               | Ubuntu 软件包                | 统一门面:Web UI(HTTP/HTTPS)+ CDP 端点,支持 WebSocket              |
| labwc               | Ubuntu 软件包                | 无头 Wayland 桌面,默认启用(`DISPLAY_BACKEND=wayland`)             |
| Xvfb / PulseAudio   | Ubuntu 软件包                | X11 显示器(`DISPLAY_BACKEND=x11`)+ 音频,供串流                  |

nginx 是唯一的对外门面,且每个代理都支持 WebSocket(CDP 和 Selkies 信令都需要)。nginx 后面的服务不监听任何 TCP 端口,回环地址上也没有:Selkies、CDP 网关和鉴权服务都在 `/tmp/agentene` 下的 unix socket 上,浏览器只通过管道(`--remote-debugging-pipe`)与网关说 CDP —— 浏览器根本没有 DevTools 端口。回环端口从浏览器内部是能访问到的:打开该地址的网页就能绕过 nginx 的登录和网关的检查,直接与监听者通信。

## 快速开始

### Docker Compose

```bash
git clone https://github.com/agentene/browser.git
cd browser

cp .env.example .env        # 可选 —— 默认值即可直接跑
docker compose up -d --build
```

然后:

* **桌面串流**:<http://localhost:8080> —— Chromium 窗口实时画面。
* **CDP 端点**:<http://localhost:9222/json/version> —— 供 Playwright 等客户端连接。

常用命令:

```bash
docker compose logs -f            # 跟随日志
docker compose exec browser bash  # 进入容器 shell
docker compose down               # 停止并删除容器(以及 compose 创建的网络)
```

### 纯 docker run

```bash
docker build -t agentene/browser .

docker run -d --name agentene-browser \
  --restart always \
  -p 8080:80 \
  -p 9222:9222 \
  -v "$PWD/browser:/browser" \
  agentene/browser
```

传给容器的首参数若不是隐式的 `start`,会被直接 exec,例如 `docker run -it agentene/browser bash` 进入 shell。

## 端口

两组相互独立的变量,都在 `.env` 里设置:**容器侧**端口是 nginx 在容器内实际监听的端口;**宿主侧**端口是 docker 发布出去的端口(compose 会自动把它映射到容器侧端口)。

| 服务               | 容器端口(默认) | 设置变量                  | 宿主端口(默认) | 设置变量                               |
| ------------------ | -------------- | ------------------------- | -------------- | -------------------------------------- |
| Web UI(HTTP)       | 80             | `NGINX_LISTEN_HTTP_PORT`  | 8080           | `NGINX_HTTP_PORT`                      |
| Web UI(HTTPS,可选) | 443            | `NGINX_LISTEN_HTTPS_PORT` | 8443           | `NGINX_HTTPS_PORT` + [HTTPS](#https-1) |
| Chromium CDP       | 9222           | `CDP_LISTEN_PORT`         | 9222           | `CDP_PORT`                             |

修改容器侧端口主要用于 `network_mode: host` / 共享网络命名空间,或 docker 网络里的对端需要特定端口的场景;普通端口发布用默认值即可。它们彼此之间、与 `PORT_FORWARDS` 监听端口都不得冲突 —— 冲突时入口脚本直接报错退出(nginx 后面的服务不占用端口)。用 `docker run` 时通过 `-e` 传入,并相应调整 `-p`(例如 `-e CDP_LISTEN_PORT=9333 -p 9222:9333`)。

除这些端口外,`PORT_FORWARDS` 可以追加额外的监听端口,反向代理到 docker 网络里的兄弟容器 —— 见 [Docker 网络(compose)](#docker-网络compose)。使用 host 网络时完全没有端口发布,容器侧端口直接绑定在宿主机上 —— 见 [Host 网络(compose)](#host-网络compose)。

## 通过 CDP 接入 Playwright

镜像把 Chromium 的 DevTools 协议经 nginx 对外暴露,宿主机(或任何可达网络)上的 CDP 客户端都能驱动这个浏览器,本地**无需**安装 Playwright 浏览器。

```bash
npm init -y && npm i playwright
node examples/connect-playwright.mjs https://example.com
```

<details>
<summary>examples/connect-playwright.mjs(核心逻辑)</summary>

```js
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://localhost:9222");
const context = browser.contexts()[0];            // 复用默认 context
const page = context.pages()[0] ?? await context.newPage();

await page.goto("https://example.com");
console.log(await page.title());
await browser.close();  // 只关闭 CDP 会话,不关浏览器
```

</details>

说明:

* 默认 context 使用**持久化配置目录**,登录态和 cookies 在多次运行间保留。
* `curl http://localhost:9222/json/version` 是最快速的健康检查。
* Puppeteer 同样适用:`puppeteer.connect({ browserURL: "http://localhost:9222" })`。它的 `browser.close()` 会发送 CDP `Browser.close`,这会关掉所有客户端共享的浏览器(由于容器托管着它,容器也会随之退出);网关会代为应答,只关闭该客户端自己的连接,效果等同于 `browser.disconnect()`。设置 `CDP_ALLOW_BROWSER_CLOSE=true` 则原样转发。
* 设置了 [CDP API Key](#登录与-cdp-api-key) 之后,通过请求头携带:`chromium.connectOverCDP(url, { headers: { Authorization: "Bearer <key>" } })`(Puppeteer:`connect({ browserURL, headers })`;`examples/connect-playwright.mjs` 读取 `CDP_API_KEY`)。未设置时端点保持开放,与以前一样。
* 网页无法使用 CDP API:凡是带 `Origin` 请求头的 CDP 请求(某个浏览器里网页发起的 WebSocket 握手或 `fetch`,比照 Chromium 的 `--remote-allow-origins` 规则检查)或 `Sec-Fetch-Site` 不是 `none` 的请求,网关一律拒绝(403)—— 网页的请求要么跨站、要么同站、要么(在 DNS rebinding 之后,即某个网站把自己的域名指向这个容器)同源,而同源 GET 连 `Origin` 都不带,只有 `Sec-Fetch-Site` 能把它和客户端请求区分开。因此无论是否设置了 API Key,你(或容器自己的浏览器)打开的任何网站都无法接管浏览器。Playwright、Puppeteer 等 CDP 客户端既不发 `Origin` 也不发 `Sec-Fetch-*`,不受影响;在地址栏打开 `/json/version`(`Sec-Fetch-Site: none`)也不受影响。需要放行某个页面(例如 DevTools 前端 `devtools://devtools`)时,把它的 origin 写进 `CDP_ALLOW_ORIGINS`。少数非浏览器客户端也会发送 `Origin` —— 例如 Python 的 `websocket-client`,除非传入 `suppress_origin=True` —— 它们会收到 403,与 Chromium 111 起自身的行为一致;网关日志里会写明被拒绝的 origin。
* `/json/new` 只接受 `PUT`,与 Chromium 本身一致(`GET` 返回 405),因此一个链接或图片无法打开标签页。
* **本地文件只限于 `CDP_FILE_DIRS`**(默认 `/browser/downloads`,即宿主机上的 `./browser/downloads`)。让浏览器按路径读取文件的 CDP 命令(文件输入框的 `DOM.setFileInputFiles`、拖放、PWA 启动、加载解压的扩展),只有文件位于这些目录之内时才放行,否则拒绝;Playwright 以 buffer 方式上传(`setInputFiles({ name, mimeType, buffer })`)不受影响,客户端本机上的路径也不受影响(它们在容器里本来就不存在)。客户端指定的下载目录如果不在其中(Playwright 的 `connectOverCDP` 会指定客户端本机的临时目录),会被改到第一个目录,浏览器自己的下载也保存在那里。
* **`Target.exposeDevToolsProtocol` 一律拒绝**(不论 `CDP_FILE_DIRS` / `CDP_ALLOW_BROWSER_CLOSE` 如何设置):它会让页面脚本拥有一条直通浏览器的 CDP 通道,上面这些检查都看不到。出于同样的原因,浏览器没有 DevTools 端口(打开该地址的网页就能使用它),网关通过管道驱动浏览器;`/json/*` 由网关基于 CDP 生成(`/json/protocol` 在构建镜像时从浏览器二进制中抓取)。在浏览器里打开的 DevTools 窗口同样拥有这样一条通道 —— `CHROMIUM_ALLOW_DEVTOOLS=false` 可以禁止它们。

## CDP 网关(带登录态的隔离 context)

*隔离*的 CDP 客户端,包括 Playwright 里的 `browser.newContext()`,以及配置了 `"isolated": true` 的 [playwright-cli](https://github.com/microsoft/playwright-cli) session,通常拿到的是一个空白、只存在于内存里的 context,持久化 profile 里的登录态一个都没有。本镜像在 CDP 端口前始终运行一个网关,它会为每个这样的 context 提供**一个独立的浏览器**:一个运行在主 profile 克隆上的独立 Chromium。每个隔离 context 一开始就带着主浏览器的全部登录态,而它做的任何操作都不会影响主浏览器,也不会影响其它隔离 context。

客户端**无需任何改动**,照常连接 `http://localhost:9222`。例如下面这份 playwright-cli 配置会让每个 `-s=<session>` 都得到一个自己的、带登录态的隔离 context:

```json
{ "browser": { "browserName": "chromium", "isolated": true, "cdpEndpoint": "http://localhost:9222" } }
```

> [!TIP]
> Playwright 会给每个新 context 设置默认 1280×720 的 viewport,页面看到的*屏幕*也随之变成 1280×720,和主浏览器的真实屏幕不一致。有风控的网站(电商、银行等)可能把它当成另一台设备,判定登录异常。在 `browser` 里加上 `"contextOptions": { "viewport": null }`,隔离 context 就会和默认 context 一样使用真实窗口尺寸。

工作原理:

* nginx 把 CDP 端口转发给一个小网关(`/usr/local/lib/cdp-gateway/gateway.mjs`)。
* 使用默认 context(`browser.contexts()[0]`)的客户端原样直通到主浏览器,行为不变。
* 客户端新建 context 时,网关自己处理 `Target.createBrowserContext`:
  * 复制 profile,跳过缓存和已打开的标签页(隔离 context 和任何新建 context 一样从零个页面开始)。profile(`/browser/user-data`)与克隆(`/browser/contexts`)同在 `/browser` 挂载上,宿主机为 XFS 或 btrfs 时,复制是 reflink(瞬间完成、写时复制),否则是完整复制。网关日志(`/tmp/cdp-gateway.log`)启动时会写明是哪一种;
  * 在副本上启动一个 Chromium;
  * 再从主浏览器把实时 cookie(含 HttpOnly 和会话 cookie)和主浏览器已打开 origin 的实时 localStorage 补写进去,因为 Chromium 写这两样到磁盘都有延迟;
  * 把这个 context 的流量路由到新浏览器。
  * 整个过程约 0.2–0.3 秒。
* context 背后的浏览器与 context 同生共死。关闭 context 或客户端断开(`playwright-cli -s=… close`)即销毁它:结束进程、删除克隆。下一个 session 会得到全新的克隆,因此总是带着主浏览器当前的登录态。
* 每个隔离 context 继承的是它启动那一刻 profile 里的全部内容(cookie、localStorage、IndexedDB、Service Worker、扩展……)。之后主浏览器的变化不会流入正在运行的隔离 context,隔离 context 里的改动也永远不会流回主浏览器。

CDP 控制台在 **`http://localhost:9222/console/`**,和 CDP 在同一端口,处于同一信任边界。主浏览器和每个隔离 context 各占一张卡片:左边是当前 tab 的实时缩略图,标题显示在缩略图底部的半透明横幅里;右边是一个与缩略图等高、可滚动的列表,列出所有打开的 tab,当前 tab 高亮。点列表里的 tab(或缩略图)会让浏览器切换到该 tab,并把窗口提到最前。窗口当前在桌面最前面(也就是 Selkies 画面里看到的)的那个浏览器,卡片会带一圈柔和的辉光,*Show* 按钮的位置换成 *Showing* 标记。卡片实时更新:页面与网关之间保持一条 WebSocket(`/console/ws`),网关只推送变化的部分 —— tab 打开、关闭或改名,当前 tab 切换,新的缩略图(只在有控制台打开时生成;桌面最前面的浏览器最多每 2 秒一张,其他浏览器最多每 20 秒一张)。每张卡片还提供两个操作:

* 「Show」把对应浏览器窗口提到 Selkies 画面最前;
* 「Delete」强制关闭隔离 context 并断开它的客户端。

顶部的 **+** 图标按钮（新建浏览器）会复制主浏览器配置，打开带有空白标签页的独立浏览器。它与 CDP 创建的 context 共用 `CDP_CONTEXTS_MAX` 上限，关闭控制台不会结束它；删除其卡片会停止浏览器并清理副本。鼠标悬停或键盘聚焦标签行时，行内右侧才显示 **×** 按钮，标签行宽度保持不变（触屏设备始终显示），平时标题使用完整行宽。按钮仅关闭对应标签（包括自动化正在使用的标签）。关闭最后一个标签可能结束该浏览器。侧边栏提供相同操作；`CDP_CONSOLE_ACTIONS=false` 会隐藏这两个入口并禁用对应 API。

每个隔离 context 有自己的浏览器边框颜色,与控制台卡片颜色一致,方便在桌面上区分窗口。控制台页面的状态只通过 `/console/ws` WebSocket 获取:连上时先收到一份全量快照,之后只收变化;页面上的操作则是 `/console/api/` 下的普通 HTTP 请求,所有写操作(`POST`/`PATCH`/`DELETE`)都必须带 `X-CDP-Console: 1` 请求头,跨站表单无法发送它。控制台(以及下面的侧边栏)支持英文和简体中文:默认跟随浏览器语言,可在设置菜单(标题栏的齿轮按钮)里切换(按浏览器记住)。

桌面上新打开的浏览器窗口(例如新隔离 context 的窗口)默认会切到最前,和一般窗口管理器的行为一样。在同一个设置菜单里关闭 *新窗口切到最前*,之后新窗口就会开在当前最前窗口的后面,自动化任务不会抢走你正在看的窗口;「Show」仍然可以把任意窗口切到最前。开关只影响之后新打开的窗口,并保存在服务端:控制台的设置存放在 `/browser` 挂载下的 `/browser/settings/settings.json`(按分组组织的 JSON 对象,例如 `{"desktop": {"raiseNewWindows": false}}`),容器重启或重建后依然保留;这些设置没有对应的环境变量,控制台通过 `GET` / `PATCH /console/api/settings` 读取和修改。语言设置因人而异,仍保存在各自的浏览器里。浏览器以有头模式运行时才显示这个开关。Wayland 下由 labwc 在新窗口映射时、画出第一帧之前把它放到底层;X11 下由屏幕跟随进程代替缺失的窗口管理器(Chromium 改为请求它激活窗口,而不是自己置顶),因此不存在事后再切回去的过程。

同一个控制台也放在了**实时桌面旁边**:把鼠标移到 Selkies 页面的右边缘,点出现的拉手即可展开(触屏上拉手常显)。拖动侧边栏的左边缘可以调整宽度,最宽为页面宽度的一半或 1000px(取较小者,按浏览器记住),卡片随宽度自适应,空间足够时并排显示。侧边栏提供与 `/console/` 相同的卡片和操作;*Show* 会直接在你正在看的串流里置顶对应窗口。nginx 把侧边栏脚本(`cdp-gateway/panel.js`)注入 Selkies 页面,并把它的 API 和 WebSocket(页面旁的 `cdp-console/`,因此 `SELKIES_SUBFOLDER` 下也能用)代理到网关。两者都跟随内置登录;WebSocket 还只接受同源页面的连接。只要 Selkies 和 CDP 端点同时启用,侧边栏就会出现。

**看到 AI Agent 在做什么。** CDP 输入(`Input.dispatchMouseEvent`、`Input.dispatchKeyEvent`、`Input.insertText` 等)直接送进页面:串流里能看到页面的反应(悬停样式、点击效果、输入的文字),却看不到指针移动和按键,原生弹出物也跟着桌面自己的指针走(tooltip 出现在桌面指针停留的位置,而不是 Agent 指向的位置)。因此 Selkies 页面会在串流上叠加画出 CDP 客户端的输入(`CDP_INPUT_OVERLAY`,默认开启):每个 CDP 连接一个彩色指针(`AI #1`、`AI #2`……),每次点击一个圆环(右键为虚线、双击标 `×2`),滚轮显示箭头,左下角一行显示它按下的组合键(`Ctrl+A`、`Enter`)和输入的文字。网关本来就会经手每条发往浏览器的客户端命令,所以客户端和页面都不需要任何改动,也不会往页面里注入任何东西;网关根据窗口位置和页面缩放把视口的 CSS 像素换算到桌面坐标,并把每个标记延迟约一个串流延迟再画,让它和画面同步。
* 在密码、一次性验证码、银行卡字段里(或焦点在 frame 内、无法判断是哪个字段时)输入的文字显示为 `••••` 加字数。`CDP_INPUT_OVERLAY=keys` 对所有文字都只显示字数;`off` 关闭叠加层(不注入脚本,网关也不做任何监听)。
* 串流看不到的指针输入(后台标签页、不在最前的窗口、无界面的 context)不画指针,改为显示一个徽标说明 Agent 正在哪里操作;它的按键和输入照常显示,卡片上会标出所在标签页:标签页标题,所在浏览器窗口不在前台时加上浏览器名(主浏览器、`context-1` 等),两个标签页同名时再加上网站域名,如 `AI #2 (context-1 › Pull requests)`。
* CDP 控制台(侧边栏和 `/console/`)会在 Agent 正在操作的标签页上加同样编号、同样颜色的 `AI #2` 标记:标签页列表里的那一行和浏览器卡片标题上都有,点卡片上的标记即可切到那个标签页;Agent 最后一次输入后一分钟内保留。
* 只有侧边栏的用户能看到(内置登录;叠加层的 WebSocket 是同源的 `cdp-console/overlay`),每位观看者都可以在侧边栏设置里用 *显示 AI 操作* 隐藏它(按浏览器记住)。没人观看时没有任何开销;有人观看时,网关对每个要画的页面每秒最多查询一次它在桌面上的位置。
* 局限:客户端仿真了视口(`Emulation.setDeviceMetricsOverride`,例如 Playwright 在自己新建的页面上用 `viewport` 选项)时指针变为虚线,位置是近似的;用脚本完成的点击(通过 `Runtime.evaluate` 执行 `element.click()`)不是输入,不会显示。

**主浏览器归网关所有。** 容器监管的常驻服务是网关而不是浏览器:主浏览器由网关作为子进程启动,因此关闭浏览器(关掉它的窗口、点卡片上的 **Stop**、`CDP_ALLOW_BROWSER_CLOSE=true` 时客户端的 `Browser.close`)或浏览器崩溃都不会让容器退出,只会断开它上面没有隔离 context 的 CDP 客户端。默认(`CHROMIUM_AUTOSTART=true`)网关随容器一起启动主浏览器;设置 `CHROMIUM_AUTOSTART=false` 后,容器启动时不启动主浏览器,闲置的容器里完全没有 Chromium 进程。无论哪种,已停止的主浏览器都会在以下时机再次启动:

* 有 CDP 客户端用到默认 context 时(`/json/new`、`browser.contexts()[0].newPage()`、任何发往主浏览器页面的命令)。仅仅连接不会启动它:主浏览器停止期间,网关自己应答客户端的握手(`/json/version`、`Browser.getVersion`、`Target.setAutoAttach` 等),等浏览器起来后再把这些设置重放过去,所以客户端无需改动 —— 第一条需要它的命令只是多等浏览器启动的一两秒。只在隔离 context 里工作的客户端(`browser.newContext()`、playwright-cli)完全不会让它运行。需要注意:在它停止时连接的客户端,在自己打开页面之前看不到任何页面(`(await browser.pages())[0]` 为空 —— 请写成 `pages()[0] ?? newPage()`);
* 在 `/console/` 或 Selkies 侧边栏里点主浏览器卡片上的 **Start browser**。

**Stop** 的关闭方式与关窗口相同,cookie 和会话会先保存到 profile。列表类请求(`/json/list`)和控制台都不会启动它,所以 `ENABLE_SELKIES=false` 时 compose 的 healthcheck 改为探测 `/json/list`。

**隔离 context 不依附于主浏览器。** 每个隔离 context 都是独立的浏览器进程,和主浏览器一样是网关的子进程,因此主浏览器关闭(关窗口、**Stop**、空闲超时、崩溃)时,它们以及它们客户端的连接都会继续运行:这类客户端会收到其主浏览器页面已消失的通知(`Target.detachedFromTarget` / `Target.targetDestroyed`,与页面关闭时相同),发往主浏览器的未完成命令会失败,而隔离 context 照常工作。之后如果它再用到默认 context,网关会为它重新启动主浏览器。没有隔离 context 的客户端仍会像以前一样被断开。

把 `CHROMIUM_IDLE_TIMEOUT` 设为分钟数后,主浏览器空闲满这么久时网关会再次关闭它。空闲指:没有 CDP 客户端在使用它,也没有人在看 Selkies 串流(可能有人正在手动使用浏览器)。持有隔离 context 的客户端只有在给主浏览器发命令时才算在使用它,所以只在隔离 context 里工作的 agent 不会让主浏览器一直开着。关闭方式与 **Stop** 相同,下一个客户端或 *Start browser* 会再把它启动起来。桌面组件(Xvfb 或 labwc、PulseAudio、Selkies)仍然常驻,没有人观看时开销很小。

局限:

* 每个隔离 context 是一个完整的浏览器进程,通常占几百 MB 内存。`CDP_CONTEXTS_MAX` 限制同时运行的数量;超出上限时,新建 context 会返回明确的 CDP 错误。
* CDP 协议里不带 session 名,所以一个隔离 context 绑定一个连接。用同一个名字重新打开 playwright-cli session,得到的是新的隔离 context,而不是原来那个。
* 只有一个连接上的*第一个*隔离 context 会获得独立的 profile 克隆浏览器。同一连接上再调用 `browser.newContext()`(包括同时发起的,例如放在 `Promise.all` 里),得到的是该浏览器内部的普通无痕 context,不带登录态;需要另一个带登录态的 context 时请新开一个连接。
* profile 是在主浏览器运行期间复制的。cookie 和已打开站点的 localStorage 会实时补同步(见上文),但其他数据库(IndexedDB、历史记录等)按复制那一刻磁盘上的状态复制,因此主浏览器在复制期间写入的内容可能在克隆里缺失,极少数情况下只写了一半。
* 按 context 设置的 `proxy`(`browser.newContext({ proxy })`,即 CDP 的 `proxyServer` / `proxyBypassList`)会成为该隔离 context 自己的代理:它的浏览器以 `--proxy-server` / `--proxy-bypass-list` 启动(排在 `CHROMIUM_EXTRA_ARGS` 之后,因此优先于那里设置的代理),代理认证照常可用。格式不合法时,创建 context 会失败。其他需要全新 context 才生效的选项不起作用:隔离 context 沿用主浏览器的设置。

## 观看桌面

打开 <http://localhost:8080>。Selkies 把虚拟显示器画面(含音频)直接串流到浏览器标签页 —— 键盘鼠标输入会送进容器。Chromium 默认有头运行(`CHROMIUM_HEADLESS=0`),每一步自动化都能在串流里看到。可用 `CHROMIUM_LANG` / `CHROMIUM_START_URL` 控制浏览器初始状态。

首次访问时会要求设置管理员账号(或选择跳过)—— 见[登录与 CDP API Key](#登录与-cdp-api-key)。

### 挂载到子路径

要把 Web UI 挂到 `https://example.com/desk/` 这样的路径下,在 `.env` 里设置前缀(首尾斜杠可选,也支持 `/tools/desk` 这类多级路径):

```bash
SELKIES_SUBFOLDER=/desk
```

此时 Selkies 把页面、静态资源、API 和 WebSocket 全部放在 `/desk/` 下提供,nginx 会把 `/` 和 `/desk` 重定向到 `/desk/`。外层反向代理必须**原样**转发路径(不要剥离前缀),并保留 WebSocket 头,例如 nginx:

```nginx
location /desk/ {
    proxy_pass http://docker-host:8080;   # 不带 URI 部分 -> 路径原样转发
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400s;
}
```

## 登录与 CDP API Key

`ENABLE_AUTH=true`(默认)时,nginx 后面会运行一个小型内置鉴权服务:

* **首次启动。** 完成初始化之前,访问 web UI 或 CDP 控制台(CDP 端口上的 `/console/`)都会先显示初始化表单:先输入 **设置码**,再创建管理员用户名 + 密码(至少 8 个字符),或选择 **跳过,不启用登录** —— 这个选择同样会被保存,web UI 保持开放,与以前一样。设置码在每次启动时打印到容器日志里(`docker compose logs browser | grep 'setup code'`;每次启动都会换一个),所以光是第一个打开页面还不能占用这个浏览器 —— 完成初始化的人还必须能看到容器日志。脚本化初始化时可以设置 `AUTH_SETUP_CODE` 并一起发送:`POST <web UI>/__auth/api/setup`,请求体为 `{"code": "…", "skip": true}` 或 `{"code": "…", "username": "…", "password": "…"}`。
* **登录。** 启用登录后,所有 web UI 请求(Selkies 页面及其 WebSocket、控制台侧边栏)以及 CDP 端口上的控制台都需要会话:否则就地显示登录表单(HTTP 401)。会话是 `HttpOnly`、`SameSite=Lax` 的 cookie,有效期 7 天,并会自动续期:只要还开着任一 web UI 或控制台页面(包括闲置在后台的标签页),它大约每天换一次新 cookie(只用一个定时器,每天至多一个很小的请求),所以会话要在最后一个页面关闭 6–7 天后才过期。可以同时在任意多个浏览器里登录;同一主机的 web 端口与 CDP 端口共用。携带该 cookie 的跨源写请求和 WebSocket 会被拒绝(403)。同一地址 15 分钟内密码错误 10 次后,在该时间窗内返回 429。
* **CDP API Key。** 可选。设置后,CDP API(CDP 端口上的 `/json/*`、`/devtools/*`)需要在请求头里携带它 —— `Authorization: Bearer <key>` 或 `X-API-Key: <key>` —— 否则返回 401;留空即不需要 key,CDP 端点保持开放(这是默认值,已有客户端不受影响)。会话 cookie 不能打开 CDP API。跳过登录时,API Key 就是证明浏览器归属的凭据:此时修改或移除它、或者设置登录,都需要提供当前的 key。
* **修改。** 控制台的设置菜单(`/console/` 及 Selkies 页面侧边栏里的齿轮)里有 *访问控制* 一组:**登录 → 修改…**(当前密码、新用户名 + 密码;用户名和两个密码框都留空即关闭登录 —— 之前跳过的也可以在这里设置登录)、**CDP API Key → 修改…**(当前密码,然后手动输入或 *随机生成*、*复制*;留空即移除)以及 **退出登录**。修改登录账号会让其他所有会话退出。没有控制台时(`ENABLE_CDP=false`),同样的控件在账号页 `<web UI>/__auth/` 上。
* **存放位置。** `/browser` 挂载下的 `/browser/settings/auth.json`(权限 0600):密码以加盐 scrypt 哈希保存,API Key 以 SHA-256 哈希保存(无法再次查看 —— 设置时请复制),外加会话密钥。容器重启或重建后依然保留,没有对应的环境变量。**忘记密码?** 删除该文件(`docker compose exec browser rm /browser/settings/auth.json`,或宿主机上的 `./browser/settings/auth.json`):下次访问会重新显示初始化表单,无需重启(表单需要容器最近一次启动时日志里的设置码)。文件存在但无法解析时,web UI 和 CDP API 会保持锁定,直到修复或删除它。

`ENABLE_AUTH=false` 关闭以上全部功能:没有初始化表单、没有登录、没有 API Key —— web UI 与 CDP 端点像旧版本一样开放。`PORT_FORWARDS` 监听端口不受登录保护。

## 配置

全部通过环境变量配置;使用 Compose 时写入 `.env`(模板见 [.env.example](.env.example))。未在 `compose.yaml` 里显式列出的变量也会经 `env_file` 直通进容器 —— 包括 Selkies 原生设置,如 `SELKIES_FRAMERATE=30`、`SELKIES_TURN_URL=...`。

`SELKIES_INTERNAL_PORT`、`CDP_INTERNAL_PORT`、`CDP_GATEWAY_INTERNAL_PORT`、`AUTH_INTERNAL_PORT` 和 `SELKIES_ADDR` 已移除:nginx 后面的服务改用 unix socket,浏览器改用 DevTools 管道(见[镜像里有什么](#镜像里有什么))。仍然设置的值会被忽略,并在容器日志里给出警告。

### 构建参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `CHROME_VERSION` | `157.0.8103.78` | [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) 版本(默认钉 Stable 通道;CfT known-good 列表中的任意版本均可) |
| `NODE_VERSION` | `26` | Node.js 主版本(由 [`update-chrome-node.mjs`](#版本联动脚本) 保持同步) |
| `SELKIES_VERSION` | `2.2.1` | Selkies 上游 release;其 wheel 及 pixelflux/pcmflux 依赖 wheel 从 GitHub release 下载,摄像头/手柄 interposer 由同一 tag 的源码编译(见 `Dockerfile`) |
| `TZ` | `UTC` | 容器时区,以 `ENV TZ` 暴露(运行时可覆盖) |

```bash
docker compose build --build-arg CHROME_VERSION=<version>
```

### 环境变量

**服务开关**

| 变量             | 默认值 | 说明                                               |
| ---------------- | ------ | -------------------------------------------------- |
| `ENABLE_SELKIES` | `true` | `false` = 跳过 Web UI + 显示器 + 音频(纯 CDP 容器) |
| `ENABLE_CDP`     | `true` | `false` = 跳过 Chromium + CDP 网关(纯远程桌面容器) |
| `ENABLE_AUTH`    | `true` | web UI + CDP 控制台的内置登录,以及可选的 CDP API Key,均在控制台中管理(见[登录与 CDP API Key](#登录与-cdp-api-key));`false` = 全部开放 |
| `AUTH_SETUP_CODE` | *(空)* | 首次启动的初始化表单要求输入的设置码(至少 8 个可见字符,不含空格);空 = 每次启动随机生成一个并打印在容器日志里。脚本化初始化时可以设置它 |

**Web UI / TLS**

| 变量                             | 默认值                                        | 说明                                                                                                                                                             |
| -------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NGINX_LISTEN_HTTP_PORT`         | `80`                                          | nginx 在容器内提供 HTTP Web UI 的端口(见[镜像里有什么](#镜像里有什么))                                                                                                           |
| `NGINX_LISTEN_HTTPS_PORT`        | `443`                                         | nginx 在容器内提供 TLS Web UI 的端口                                                                                                                             |
| `NGINX_LISTEN_ADDR`              | *(空)*                                        | 所有 nginx 监听(Web UI、CDP、`PORT_FORWARDS`)绑定的地址;空 = 所有网卡。使用 [host 网络](#host-网络compose)时建议设为 `127.0.0.1`,让 CDP 与 Web UI 只在本机可访问 |
| `ALLOWED_HOSTS`                  | *(空)*                                        | Web UI 与 CDP 端口接受的主机名,逗号分隔(`.example.com` / `*.example.com` = 同时包括其子域名),IP 地址和 `localhost` 始终接受;其他 `Host` 返回 421。用于保护开放的 Web UI / 控制台(跳过登录或 `ENABLE_AUTH=false`)免受 DNS rebinding —— 见[安全注意事项](#安全注意事项)。空 = 任意主机名 |
| `ENABLE_HTTPS`                   | `false`                                       | `true` = nginx 在容器 `NGINX_LISTEN_HTTPS_PORT` 端口同时提供 TLS 的 Web UI                                                                                       |

**额外端口转发**

| 变量            | 默认值 | 说明                                                                                                                                                                                                    |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT_FORWARDS` | *(空)* | 空格/逗号分隔的 `LISTEN=HOST:PORT` 列表:nginx 额外监听每个 `LISTEN` 端口,反向代理(支持 WebSocket)到 `HOST:PORT` —— 通常是同一 docker 网络里的兄弟容器。详见 [Docker 网络(compose)](#docker-网络compose) |

**Selkies**

| 变量                          | 默认值    | 说明                                                      |
| ----------------------------- | --------- | --------------------------------------------------------- |
| `SELKIES_ENCODER`             | `h264enc` | selkies 原生设置(原样透传):`h264enc` \| `h265enc` \| `vp8enc` \| `vp9enc` \| `av1enc` \| `h264enc-striped` \| `jpeg` |
| `SELKIES_EXTRA_ARGS`          | *(空)*    | 追加到 `selkies` 的额外 CLI 参数                          |
| `SELKIES_ENABLE_RESIZE`       | `true`    | 由浏览器驱动调整分辨率:虚拟显示器跟随观看端浏览器窗口大小(X11 下最大 8192x4096);`false` = 不论谁在观看,显示器都保持 `SCREEN_GEOMETRY` |
| `SELKIES_VIDEO_STREAMING_MODE` | `false` | Turbo 模式:`true` = 像普通视频编码器一样逐帧编码,静止桌面也不例外(有人观看时 CPU 恒定占用,1080p 下约单核 2.5%);`false` = 只编码有变化的帧,静止画面几乎不占 CPU。看视频或玩游戏时可在侧边栏实时打开 |
| `SELKIES_VIDEO_ON_START` | `true` | 会话开始时即推送视频;`false` = 需在侧边栏手动打开 |
| `SELKIES_AUDIO_ENABLED` | `true` | 音频支持;`false` = 彻底关闭音频,麦克风也随之不可用 |
| `SELKIES_AUDIO_ON_START` | `false` | 会话开始时即推送音频(容器 → 观看端);`false` = 需在侧边栏手动打开 |
| `SELKIES_MICROPHONE_ENABLED` | `true` | 接受观看端麦克风(作为 PulseAudio 源 `SelkiesVirtualMic` 提供给 Chromium) |
| `SELKIES_MICROPHONE_ON_START` | `false` | `true` = 连接即申请麦克风,`false` = 等侧边栏手动打开,`demand` = 仅在有应用录音时申请 |
| `SELKIES_WEBCAM_ENABLED` | `true` | 接受观看端摄像头(转发到 selkies 的虚拟 V4L2 设备) |
| `SELKIES_WEBCAM_ON_START` | `false` | `true` \| `false` \| `demand`,同 `SELKIES_MICROPHONE_ON_START` |
| `SELKIES_GAMEPAD_ENABLED` | `true` | 游戏手柄支持 |
| `SELKIES_GAMEPAD_ON_START` | `false` | 一开始就轮询观看端手柄;`false` = 需在侧边栏手动打开 |
| `SELKIES_SUBFOLDER`           | *(空)*    | Web UI 的 URL 路径前缀,如 `/desk` → `http://host:8080/desk/`;空 = 站点根路径(见[挂载到子路径](#挂载到子路径)) |

**Chromium / CDP**

| 变量                        | 默认值                                                                                              | 说明                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHROMIUM_HEADLESS`         | `0`                                                                                                 | `0` = 有头,显示在桌面上(Xvfb 或 labwc,串流可见);`1` = 无头                                                                                                                                  |
| `CHROMIUM_LANG`             | `en-US`                                                                                             | 浏览器 UI 语言 + `Accept-Language`(如 `zh-CN`)                                                                                                                                    |
| `CHROMIUM_START_URL`        | `about:blank`                                                                                       | 启动时打开的页面                                                                                                                                                                  |
| `CHROMIUM_AUTOSTART`        | `true`                                                                                              | 由 CDP 网关随容器启动主浏览器;`false` = 只在 CDP 客户端用到默认 context(隔离 context 不需要它)或在 CDP 控制台点 *Start browser* 时才启动。无论哪种,关闭它(或崩溃)都不会让容器退出,下一个客户端会再把它启动起来([详情](#cdp-网关带登录态的隔离-context)) |
| `CHROMIUM_IDLE_TIMEOUT`     | `0`                                                                                                 | 主浏览器空闲(没有 CDP 客户端在使用它、无人观看串流;隔离 context 不算)多少分钟后自动关闭;`0` = 不自动关闭 |
| `CHROMIUM_EXTRA_ARGS`       | *(空)*                                                                                              | 额外 chromium 参数,如 `--proxy-server=http://host:3128`                                                                                                                           |
| `CHROMIUM_GPU`              | `auto`                                                                                              | `auto` = 有直通 GPU(见 [GPU 直通](#gpu-直通可选))就用硬件渲染,否则 SwiftShader 软件渲染 —— WebGL 始终可用;`off` = 强制软件渲染;`strict` = 永不允许 SwiftShader(无 GPU 则无 WebGL) |
| `CHROMIUM_SANDBOX`          | `auto`                                                                                              | Chromium 自身的沙箱(主浏览器和 context 浏览器):`auto` = 浏览器以非特权用户运行(`RUN_USER` 不为 `0`,即默认情况)**且**容器允许创建 user namespace 时开启,否则使用 `--no-sandbox`;`off` = 始终 `--no-sandbox`。见[权限降级(`RUN_USER`)](#权限降级run_user) |
| `CHROMIUM_ALLOW_FILE_URLS`  | `false`                                                                                             | `true` = 浏览器可以打开 `file://` URL。默认禁止(托管策略 `URLBlocklist`),因为网页或 CDP 客户端可以借浏览器读取其用户能读的任何文件 —— 包括登录的会话密钥。按路径指定文件的 CDP 命令由 `CDP_FILE_DIRS` 管 |
| `CHROMIUM_ALLOW_DEVTOOLS`   | `true`                                                                                              | `false` = 浏览器不打开任何 DevTools 窗口(托管策略 `URLBlocklist`:`devtools://*`、`chrome://inspect`)。DevTools 窗口通过一条自己的通道向页面发送 CDP,绕过 CDP 网关的检查,而 CDP 客户端可以打开它(按一个快捷键,或在 `chrome://inspect` 里点一下)—— 不允许 CDP 客户端越过 `CDP_FILE_DIRS` 时设为 `false`。CDP 端点本身不受影响 |
| `CDP_LISTEN_PORT`           | `9222`                                                                                              | 公开 CDP 端点在容器内的端口(nginx → CDP 网关 → chromium;见[端口](#端口))                                                                                                                   |

**CDP 网关**(见 [CDP 网关](#cdp-网关带登录态的隔离-context))

| 变量                        | 默认值                      | 说明                                                                                                                                    |
| --------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `CDP_CONTEXTS_MAX`          | `4`                         | 同时存在的隔离 context 上限(每个都是完整浏览器);超出后新建 context 返回 CDP 错误                                                        |
| `CDP_ALLOW_ORIGINS`         | *(空)*                      | 允许使用 CDP API 的网页 origin,逗号分隔(`*` = 任意),与 Chromium 的 `--remote-allow-origins` 相同;空 = 都不允许 —— 见[通过 CDP 接入 Playwright](#通过-cdp-接入-playwright) |
| `CDP_CONSOLE_ACTIONS`       | `true`                      | 允许在控制台和侧边栏新建独立浏览器、关闭单个标签页 |
| `CDP_INPUT_OVERLAY`         | `text`                      | Selkies 页面在串流上叠加画出的 CDP 客户端输入(见上文“看到 AI Agent 在做什么”):`text` = 指针、点击、滚轮、组合键和输入的文字(密码 / 一次性验证码 / 银行卡字段及 frame 内显示为 `••••`);`keys` = 同上,但文字只显示字数;`off` = 不显示。需要 Selkies 和 CDP 同时启用 |
| `CDP_ALLOW_BROWSER_CLOSE`   | `false`                     | 客户端的 `Browser.close`(Puppeteer 的 `browser.close()`)是否关闭共享的浏览器(容器不会退出,下一个客户端会再把它启动起来);`false` = 只关闭该客户端自己的连接(及其隔离 context),`Browser.crash*` 一律拒绝 |
| `CDP_FILE_DIRS`             | `/browser/downloads`        | CDP 客户端可以指定本地文件的目录(冒号分隔):按路径读取文件的命令(`DOM.setFileInputFiles`、拖放、PWA 启动、`Extensions.loadUnpacked`)读取其他位置的文件一律拒绝(先解析符号链接),不在其中的下载目录会被改到第一个目录。第一个目录同时也是浏览器的下载目录(托管策略 `DownloadDirectory`;启动时创建并交给 `RUN_USER`)。没有这项限制,CDP 客户端可以读取浏览器用户能读的任何文件(登录的 `auth.json`),并往它能写的目录里写入新文件。`*` = 不检查,也不设策略 —— 见[通过 CDP 接入 Playwright](#通过-cdp-接入-playwright) |

**桌面 / 容器**

| 变量                | 默认值         | 说明                                                                                                                                                                                                                 |
| ------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TZ`                | `UTC`          | 容器时区(任意 IANA 时区,如 `Asia/Shanghai`)                                                                                                                                                                          |
| `DISPLAY_BACKEND`   | `wayland`      | 有头浏览器所在的桌面:`wayland` = labwc,一个无头 Wayland 合成器 + 窗口管理器,由 Selkies 在 GPU 上采集 —— 挂了 GPU 时,动画页面的 CPU 占用降低数倍,见 [Wayland 桌面](#wayland-桌面display_backendwayland);`x11` = Xvfb(+ picom)—— 使用 NVIDIA GPU 时请选它 |
| `SCREEN_GEOMETRY`   | `1920x1080x24` | Xvfb 屏幕尺寸 `宽x高x深`(`wayland` 时为 labwc 输出的尺寸);同时决定 Selkies 串流分辨率。无人观看时新建隔离 CDP context,会先把显示器恢复为该尺寸(观看端离开后会留下它自己的尺寸)                                                                                                                                 |
| `RUN_USER`          | `browser`      | 桌面栈(Xvfb 或 labwc、picom、PulseAudio、selkies、chromium、CDP 网关、认证服务)与 nginx *worker* 的运行用户 —— 未设置/为空 = `browser`(uid 1001,镜像内置);也可填已存在的用户名或 `uid[:gid]`;`0` = 全部以 root 运行。PID 1 与 nginx master 保持 root。见[权限降级(`RUN_USER`)](#权限降级run_user) |

### 权限降级(`RUN_USER`)

默认情况下,桌面栈 —— Xvfb(或 labwc)、picom、PulseAudio、selkies、chromium(以及
CDP 网关和它的 context 浏览器、认证服务),还有 nginx 的 *worker* —— 以镜像内置的非特权
用户 `browser`(uid 1001)运行。`RUN_USER` 可以改用其他用户,或者重新让所有进程以 root 运行:

```bash
# compose(.env)
#RUN_USER=browser      # 默认值(未设置或为空效果相同)
RUN_USER=1000          # 数字 uid[:gid],例如与宿主机上
                       # ./browser 的属主 uid 对齐
RUN_USER=0             # 不降权:所有进程以 root 运行
```

具体行为:

* 接受已存在的用户名(镜像内置 `browser`,uid 1001)或 `uid[:gid]`;数字 id 缺失的 passwd/group 条目会在启动时合成。`0`(以及 `0:<gid>` 或 `root`)关闭降权 —— 此时下面各条都不适用。
* PID 1 与 nginx **master** 保持 root:nginx 绑定(默认为特权的)监听端口并读取 TLS 密钥,监督进程负责准备浏览器 profile。其余进程经 `setpriv` 以无 capability 状态启动。
* 浏览器 profile(`/browser/user-data`)每次启动都会 `chown` 给该用户 —— 首次迁移较大的 root 属主 profile(例如 0.2.0 之前的版本默认以 root 运行留下的)需要一点时间,之后只是空遍历。
* GPU 设备节点保持可用:`/dev/dri` / NVIDIA 节点的宿主机 gid 会被加入补充组。
* CDP/web 端口保持不变。收益是文件系统/权限隔离 —— 浏览器被攻破后不再能以 root 写文件。
* 如果容器还允许创建 user namespace,**Chromium 沙箱**(`CHROMIUM_SANDBOX=auto`)也会随之开启:Chromium 会把渲染进程限制在独立的 user、PID、network namespace 中,并加上 seccomp-BPF(可在 `chrome://sandbox` 查看)。Docker 默认的 seccomp 配置禁止 user namespace,因此需要一个允许它的配置 —— 例如在 compose override 里写 `security_opt: ["seccomp=unconfined"]`(`docker run` 用 `--security-opt seccomp=unconfined`),代价是容器本身失去 syscall 过滤。入口脚本每次启动都会探测,并在日志里输出 `chromium: sandboxed …` 或没有开启的原因;条件不满足时浏览器继续使用 `--no-sandbox`。Chromium 的 setuid 辅助程序绕不过这个限制(它创建同样的 namespace 也需要 `CAP_SYS_ADMIN`),所以镜像里没有安装它。以 root 运行(`RUN_USER=0`)时 Chromium 根本无法启用沙箱。

### 时区与语言

默认值是对容器友好的 **UTC** 时区与**系统默认英语**(`en-US`)浏览器语言。两者都是普通环境变量覆盖,无需重新构建:

```bash
# docker run
docker run -e TZ=Asia/Shanghai -e CHROMIUM_LANG=zh-CN ...

# compose(.env)
TZ=Asia/Shanghai
CHROMIUM_LANG=zh-CN
```

`CHROMIUM_LANG` 同时决定浏览器 UI 语言和 `navigator.language` / `Accept-Language`;入口脚本会对持久化配置目录做预置,即使目录最初是用其他语言创建的也能生效(细节见 `entrypoint/lib/chromium.sh`)。

## HTTPS

TLS 在 nginx 终止。只要存在**有效**证书对(自签也算有效;"有效" = 证书与私钥可解析且互相匹配)就会**原样复用**;只有找不到可用证书对时才会生成自签证书 —— 生成到 `./tls` 挂载目录里,因此会持久化并在后续启动中复用。`./tls` 只由 `compose.https.yaml` 挂载,不开 HTTPS 就不会创建 `./tls` 目录。

**方式 A —— 快速(自签):** 在 `.env` 取消一行注释:

```bash
COMPOSE_FILE=compose.yaml:compose.https.yaml
```

一条配置同时发布 `https://localhost:8443` 并开启 HTTPS。

**方式 B —— 使用自己的证书:** 把 `fullchain.pem` + `privkey.pem` 放进宿主机 `./tls` 目录,再用上面的 overlay(或设 `ENABLE_HTTPS=true`)。已存在的有效证书对永远原样复用;损坏的证书对(无法解析、证书与私钥不匹配,或只存在其中一个文件)会让容器带明确错误直接退出,而不是被悄悄替换。

`ENABLE_HTTPS=true` 但*不*用 overlay = HTTPS 只在 docker 网络内可用(例如挂在另一个反向代理后面)—— 宿主端口不发布,也不挂载 `./tls`,自签证书对只留在容器内,容器重建时会重新生成。配合 `compose.host.yaml` 时,把 `compose.https.yaml` 放在它前面(端口映射会被丢弃,挂载保留)。

## GPU 直通(可选)

默认全部走软件渲染(SwiftShader):容器在任何机器都能跑,不需要 GPU。想用宿主机的真实 GPU 渲染,在 `.env` 里加一个 opt-in overlay:

```bash
# Intel / AMD —— 直通 /dev/dri:
COMPOSE_FILE=compose.yaml:compose.gpu.yaml

# NVIDIA —— 宿主机需要专有驱动 + nvidia-container-toolkit:
COMPOSE_FILE=compose.yaml:compose.gpu-nvidia.yaml
```

entrypoint 启动时自动探测设备(`CHROMIUM_GPU=auto` 为默认)。在默认的 Wayland 桌面上,Chromium 走它原生的 Wayland/EGL 路径(见 [Wayland 桌面](#wayland-桌面display_backendwayland));`DISPLAY_BACKEND=x11` 时则把 Chromium 切到 Vulkan/ANGLE 后端(`--use-angle=vulkan --enable-features=Vulkan`):WebGL/WebGPU 上下文经 Vulkan 渲染(原生 GL 路径在 Xvfb 上根本走不通),显示合成器也跑在 Vulkan 上(不开启合成标志时,chrome://gpu 会把 WebGL 标为 "Hardware accelerated but at reduced performance"—— GPU 帧被回读进 CPU 合成器)。实测:NVIDIA 直通 → `ANGLE (NVIDIA, Vulkan … GeForce RTX …)`;AMD 核显 → `ANGLE (AMD, Vulkan … RADV)`,`webgl/webgpu: enabled`(无回读)。此时无头模式也不再追加 `--disable-gpu`,SwiftShader 仍作为运行时兜底保留,设备中途出错 WebGL 不断供。`CHROMIUM_GPU=strict` 永不允许 SwiftShader(反指纹:浏览器不得上报软件渲染器,无 GPU 时 WebGL 不可用);`off` 即使挂了 GPU 也强制走软件路径。

镜像内置了 Intel/AMD 的 Mesa/VA-API 用户态;NVIDIA 的 GL 库无法内置(必须与宿主机驱动版本匹配)—— 由 nvidia container toolkit 在容器启动时注入。验证方式:`docker compose exec browser glxinfo -B` / `vainfo`(Intel/AMD)或 `nvidia-smi`(NVIDIA),再在串流的浏览器里打开 `chrome://gpu`,WebGL 应显示硬件渲染器。[`examples/webgl-renderer-probe.mjs`](examples/webgl-renderer-probe.mjs) 无需任何依赖即可打印 WebGL 渲染器和 `chrome://gpu` 的特性状态:`node examples/webgl-renderer-probe.mjs localhost 9222`(CDP 端点;它不发送 [API Key](#登录与-cdp-api-key),因此只在未设置 API Key 时可用)。

### Wayland 桌面(`DISPLAY_BACKEND=wayland`)

Wayland 桌面是默认桌面。挂了 Intel/AMD GPU 时,对于一切会动的内容(视频、canvas、轮播图 —— 例如 baidu.com 首页的 logo 就是一段循环播放的视频),Wayland 桌面比 Xvfb 省得多。在 Xvfb 上,浏览器窗口的每一帧都要从 GPU 读回、再经单线程的软件 X server 拷贝一遍,Selkies 还要再拷出来一遍;一个动画页面就能让 Xvfb 吃满约一个 CPU 核,而它一旦饱和,所有窗口和串流都会跟着变慢。设置

```bash
# .env  (DISPLAY_BACKEND=wayland 是默认值)
COMPOSE_FILE=compose.yaml:compose.gpu.yaml
```

后,浏览器运行在 [labwc](https://labwc.github.io/)(一个无头 Wayland 合成器 + 窗口管理器)里,Selkies 通过 screencopy 采集它的输出:帧从 Chromium 到 VA-API 编码器全程留在 GPU 上(dmabuf 零拷贝)。在 AMD 核显(Renoir)、1920x1200、打开 baidu.com 首页时实测的整个容器 CPU 占用:

| | `x11` | `wayland` |
| --- | --- | --- |
| 无人观看 | 107% | 17% |
| 有一个 Selkies 观看端连接 | 335%(Xvfb 饱和) | 29% |

与 `x11` 的区别:

* 浏览器窗口由 labwc 最大化,保留标签栏和地址栏,并且始终锁定:只显示关闭按钮,双击/中键标签栏空白处无效,拖动窗口或窗口边缘(包括 Alt+拖动)都无法移动或调整大小,标签栏右键菜单里的「最小化」/「恢复」会在不到一秒内被撤销(负责撤销的监视进程在没有窗口时休眠,空桌面不占 CPU);弹出窗口和右键菜单由合成器原生合成(不需要 picom)。Alt+Tab 切换窗口;CDP 控制台的 *Show* 通过 labwc 把窗口提到最前。
* labwc 自己的 60 Hz 帧时钟驱动浏览器,不论是否有人在看串流;被其他窗口挡住的窗口也照常渲染,所以自动化的行为与 Xvfb 上一致。
* 鼠标指针只由 Selkies 客户端在本地绘制,没有串流延迟(labwc 自己的指针不进入视频画面 —— 否则它会延迟跟随,形成第二个"重影"指针)。指针始终是箭头:screencopy 不携带光标形状,所以不像 `x11` 那样有文本/手形光标。
* Selkies 按浏览器窗口调整分辨率(`SELKIES_ENABLE_RESIZE`,默认开启)时调整的是 labwc 的输出;设为 `SELKIES_ENABLE_RESIZE=false` 时输出保持 `SCREEN_GEOMETRY`。
* Chromium 走它原生的 Wayland/EGL 路径,不使用上面的 Vulkan 标志(Chromium 不支持 Wayland 下的 Vulkan)。
* Selkies 通过 wlr-screencopy 采集 labwc(`PIXELFLUX_HOST_CAPTURE=zwlr`,由入口脚本设置)。labwc 也提供更新的 ext-image-copy-capture,pixelflux 会优先用它,但 labwc 无法导入 pixelflux 为它分配的 GPU 缓冲区,挂了 GPU 时串流根本起不来。

不起作用的情况:没有 GPU 时两种方式都纯软件渲染,开销与 `x11` 基本相同(CI 里的 `wayland` 冒烟测试就是这样跑的);使用 **NVIDIA** 时,注入的驱动栈在 Wayland 下给不了 Chromium GPU 合成 —— 这种情况请设置 `DISPLAY_BACKEND=x11`(入口脚本会给出警告)。

## 持久化

| 宿主路径(compose)      | 容器路径               | 内容                                                           |
| ---------------------- | ---------------------- | -------------------------------------------------------------- |
| `./browser/user-data`  | `/browser/user-data`   | Chromium 配置:cookies、登录态、扩展、`navigator.language` 偏好 |
| `./browser/settings`   | `/browser/settings`    | 控制台设置(`settings.json`)以及[登录 + CDP API Key](#登录与-cdp-api-key)(`auth.json`) |
| `./browser/contexts`   | `/browser/contexts`    | [CDP 网关](#cdp-网关带登录态的隔离-context)的浏览器 context,各自一份 profile 克隆(每次启动清空) |
| `./browser/downloads`  | `/browser/downloads`   | 浏览器的下载文件,以及 CDP 客户端可以按路径上传的文件(`CDP_FILE_DIRS`) |
| `./tls`                | `/etc/nginx/tls`       | TLS 证书(你自己的,或生成的自签对);仅在使用 `compose.https.yaml` 时挂载 |

`./browser` 是同一个挂载(`BROWSER_DATA_HOST_DIR`,默认 `./browser`),profile 与网关的克隆因此位于同一文件系统:宿主机是 XFS 或 btrfs 时,每个隔离 context 都从 profile 的 reflink 启动,而不是完整复制。两个宿主目录都已 git-ignore;`./tls` 只在使用 HTTPS overlay 时才会创建。配置目录就是浏览器的 `--user-data-dir`,本次运行登录的账号在 `docker compose down && up` 之后依然有效。容器停止时,entrypoint 会先用 CDP `Browser.close` 有序关闭浏览器(与关闭最后一个窗口相同),再向各服务发信号,所以即使是刚刚写入的 cookie 也会落盘;直接发信号会丢掉它们。上一容器遗留的 `Singleton*` 锁文件(Chromium 的运行时产物)会在启动时自动清理。


### Docker 网络(compose)

默认情况下 compose 把容器接入自建的 `<project>_default` 网络。`.env` 里两个变量可以改变这一行为:

```bash
NETWORK_NAME=my-net NETWORK_EXTERNAL=false   # 由 compose 创建并管理 my-net
NETWORK_NAME=existing NETWORK_EXTERNAL=true  # 接入已存在的网络,
                                             # 例如与反向代理栈共享
```

对已存在的网络请使用 `NETWORK_EXTERNAL=true`(旧版 compose 否则会报 incorrect label 错误)。

容器与兄弟容器同网之后,`PORT_FORWARDS` 可以把选定的兄弟服务映射为本容器内的端口 —— 当本容器里的浏览器或脚本期望访问 `http://localhost:<端口>` 时特别有用:

```bash
# .env —— 在本容器内通过 http://localhost:3080 访问容器 web
# 的 GUI(它对网络开放的端口是 80;它的 :3080 只绑在该容器自己的回环上,
# 从外部无法寻址)
PORT_FORWARDS=3080=web:80
# 多条目,空格或逗号分隔:
#PORT_FORWARDS=3080=web:80 6080=onlyoffice-documentserver:80
```

转发由同一个 nginx 前门提供(无额外进程):支持 WebSocket;经容器的 DNS 服务器(compose 网络下即 docker 内嵌 DNS)按请求解析对端 —— 对端容器还没起来时本容器照常启动(对端上线前请求返回 502),对端重建换 IP 后也能自动跟上。转发监听端口不得与 `NGINX_LISTEN_HTTP_PORT` / `NGINX_LISTEN_HTTPS_PORT` / `CDP_LISTEN_PORT`(默认 80/443/9222)或其他转发端口冲突 —— 冲突时入口脚本拒绝启动。

### Host 网络(compose)

想让浏览器访问宿主机上运行的应用(例如 `http://localhost:3000` 的开发服务),可用 `compose.host.yaml` overlay 让容器直接使用宿主机网络栈(`network_mode: host`):

```bash
# .env —— 组合多个 overlay 时把 compose.host.yaml 放在最后,
# 例如 compose.yaml:compose.gpu.yaml:compose.host.yaml
COMPOSE_FILE=compose.yaml:compose.host.yaml
NGINX_LISTEN_ADDR=127.0.0.1   # 建议:CDP 与 Web UI 不暴露到网络
```

该模式下的变化:

* 不发布任何端口,nginx 直接在宿主机上绑定端口。`NGINX_LISTEN_HTTP_PORT` / `NGINX_LISTEN_HTTPS_PORT` / `CDP_LISTEN_PORT` 默认取 `NGINX_HTTP_PORT` / `NGINX_HTTPS_PORT` / `CDP_PORT`(8080 / 8443 / 9222),访问地址与 bridge 模式保持一致;显式设置即可覆盖。HTTPS 只需 `ENABLE_HTTPS=true`(不需要 `compose.https.yaml`,它的端口映射会被丢弃)。
* 只有 nginx 的监听端口占用宿主机端口:nginx 后面的服务都在容器自身文件系统里的 unix socket 上,浏览器也没有 DevTools 端口,因此容器里没有任何东西绕过 nginx(以及 [CDP API Key](#登录与-cdp-api-key))暴露在宿主机回环上。
* `NETWORK_NAME` / `NETWORK_EXTERNAL` 与 `hostname` 不再生效。`PORT_FORWARDS` 仍可用,但通过宿主机的 DNS 解析(容器名无法解析)—— 通常直接让浏览器访问 `localhost:<端口>` 即可。
* 使用 `DISPLAY_BACKEND=x11` 时,若宿主机自己在 `:0` 上跑着 X server,入口脚本会自动换用下一个空闲 display。Xvfb 只监听文件系统 socket,宿主机进程无法接入容器里无认证的 display。

## 服务开关、健康检查与重启

* 容器启动 == 服务启动:入口脚本是一个极简 PID 1 监管器,**任一服务退出即退出**,配合 `--restart always` / `restart: always` 即为自动恢复。
* compose 健康检查每 30 秒轮询 `http://127.0.0.1:${NGINX_LISTEN_HTTP_PORT}/`(nginx 代理 Selkies):2xx、重定向(`SELKIES_SUBFOLDER`)或 401(开启了登录页)都视为健康,502(Selkies 未就绪)不算。`ENABLE_SELKIES=false` 时没有 Web 监听,改为探测 `http://127.0.0.1:${CDP_LISTEN_PORT}/json/version`。直接 `docker run` 没有健康检查(镜像本身未定义)。
* 同时设置 `ENABLE_SELKIES=false` 和 `ENABLE_CDP=false` 是配置错误,会立即失败。
* 日志在容器内 `/tmp/*.log`(`xvfb.log` 或 `labwc.log`、`picom.log`、`pulseaudio.log`、`chromium.log`、`cdp-gateway.log`、`nginx/*.log` 等);`docker compose logs` 显示入口脚本自身以及 Selkies、nginx 的输出。`nginx/access.log` 不记录 CDP 端口上的 `/json/*` 请求(CDP 客户端会轮询它们,常常每秒一次)。

## 从源码构建

```bash
docker compose build            # 或:docker build -t agentene/browser .
```

单阶段 Dockerfile,各部分各自成层地安装:Node.js、Chrome for Testing 及其系统依赖、nginx、Xvfb/PulseAudio/labwc、Selkies 官方 release wheel,以及 CDP 网关的 npm 依赖(按 lockfile `npm ci`)。Chrome 直接从 Chrome for Testing 官方存储桶下载(不经过 Playwright);Selkies 及其 `pixelflux`/`pcmflux` 依赖从各自的 GitHub release 下载。

`docker build --check .` 通过,无警告。

## 版本联动脚本

[`update-chrome-node.mjs`](update-chrome-node.mjs) 基于实时元数据([Chrome for Testing 版本源](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json)的 Stable 通道 + Node.js 发布索引中最新的 LTS 主版本)统一重钉 `Dockerfile`、`compose.yaml` 以及两个 README 构建参数默认值表格中的 Chrome 与 Node 版本。Chrome 版本必须提供 `linux64` 构建:

```bash
node update-chrome-node.mjs                  # 钉到最新的 Stable Chrome for Testing
node update-chrome-node.mjs <version>        # 钉到指定的 known-good 版本
node update-chrome-node.mjs --check          # 偏差检查:有偏差则退出码 1,不改任何文件
node update-chrome-node.mjs --node 22        # 强制指定 Node 主版本,而不是最新 LTS
```

## CI/CD 与发布的镜像

[![ci](https://github.com/agentene/browser/actions/workflows/ci.yaml/badge.svg)](https://github.com/agentene/browser/actions/workflows/ci.yaml)

每个 pull request 以及每次推送到 `main` 都会运行 [`ci.yaml`](.github/workflows/ci.yaml):静态检查(hadolint、`docker build --check`、shellcheck、`node --check`、`py_compile`)、完整镜像构建、运行时冒烟测试(CDP 端点、Web UI、CDP 网关、Wayland 与 X11 桌面)。只有 `main` 会发布版本 —— `dev` 与特性分支只做测试。合入 `main` 的变更构成一次发布时(见下文),同一次 CI 运行会构建并发布 `linux/amd64` 镜像(Dockerfile 只支持这一种架构);只有改了 `VERSION` 的发布才打 git 标签:

* **GHCR**:`ghcr.io/agentene/browser`(使用内置 `GITHUB_TOKEN`)
* **Docker Hub**:`agentene/browser`(与 GHCR 同为 `<owner>/<repo>` 路径;需要仓库 secrets `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`,且该账号有权推送到此命名空间;未配置则跳过)

版本规则:项目自身版本 `X.Y.Z`(semver)记录在 [`VERSION`](VERSION) 文件中,手动升级。发布分两类:

* **代码版本 `v<X.Y.Z>`**(例如 `v0.1.0`)—— `VERSION` 的变更合入 `main` 时打出的 git 标签(通常是 `dev` → `main` 的合并)。镜像内置该提交上钉住的 Chrome for Testing。
* **Chrome 版本**(例如镜像标签 `0.1.0-150.0.7871.100`)—— 每日 Chrome 升级,**合入时不打 git 标签**;`X.Y.Z` 不变,镜像标签后缀记录同一份代码重新构建所用的 Chrome。

两者发布相同的镜像标签(Chrome 版本发布的唯一产物就是这些镜像标签):

| 镜像标签 | 示例 | 含义 |
| --- | --- | --- |
| `<X.Y.Z>-<chrome 版本>` | `0.1.0-150.0.7871.100` | 精确构建:项目版本 + 该提交钉住的 Chrome for Testing —— 需要可复现部署时钉这个 |
| `<X.Y.Z>` | `0.1.0` | 该项目版本下最新的构建(随每次 Chrome 升级移动) |
| `latest` | | 最新发布 |

合入 `main` 时既没改 `VERSION` 也没改 Chrome 版本,则不发布任何版本(运行中会留下 notice)—— 所以请在 `dev` 上先升级 `VERSION` 再合并。`publish` job 会拒绝既不是所在提交的 `v<VERSION>`、也不是 `v<VERSION>-<chrome 版本>` 的 git 标签,以及所在提交不在 `main` 上的标签。发布版本不推 `sha-<短哈希>` 标签;只有在 `main` 上手动运行 workflow(无标签)时才推,且只推这一个。

### 上游版本自动更新

[`chrome-update.yaml`](.github/workflows/chrome-update.yaml) 每天定时(也支持手动触发)监视 Chrome for Testing 版本源中新的 Stable 版本,并驱动整个闭环:

1. `update-chrome-node.mjs` 重新钉住仓库中的 Chrome 与 Node 版本;
2. 自动开启一个包含变更 diff 的 bump PR;
3. `ci.yaml` 在该 PR 上运行(lint + 完整构建 + 冒烟测试);
4. CI 全绿后 PR 以 squash 方式自动合并;
5. 同一次运行中的 `publish` job 构建镜像 → 以 `<X.Y.Z>-<chrome 版本>` 发布到 GHCR / Docker Hub(Chrome 升级不打 git 标签);
6. `ci.yaml` 中的 `cleanup-update-branch` job 删除已合并的 `chore/chrome-update` 分支(若新一轮 bump 已复用该分支则保留)。

合入 main 的 `VERSION` 变更仍由 `release-tag` job 打成代码版本标签 `v<X.Y.Z>`(一次合并同时改了 `VERSION` 和 Chrome 版本时,以代码版本为准)。每个 git 标签只发布一次:标签已存在时 job 跳过并给出警告 —— 要再次发布代码改动,请升级 `VERSION`。

要实现全自动,需一次性配置:

* **仓库 secret `CHROME_UPDATE_TOKEN`** —— 经典 PAT(需 `repo` 权限)或 fine-grained PAT(需 *Contents* + *Pull requests* 读写)。需要它是因为 GitHub 对用内置 `GITHUB_TOKEN` 创建的 PR 绝不触发 `on: pull_request`(bump PR 将没有 CI 检查)。不配置该 secret 时 bump PR 照常开启、等待人工合并(关闭再重开该 PR 可强制触发 CI)。发布不依赖它:它就在合并本身的 CI 运行中完成。
* **Settings → General → Pull Requests → "Allow auto-merge"** 打开,PR 才能在检查通过后自行合并。

不配置 secret 时流程仍然完整,只是加了人工闸门:PR 照常开启,你验证后手动合并,发布随后自动完成。手动推送的 git 标签只要是 `main` 上某个提交的 `v<VERSION>` 或 `v<VERSION>-<chrome 版本>` 也会发布;手动改 Chrome 版本或 `VERSION` 合入 main 也会同样自动发布(仅 `VERSION` 变更时打 git 标签)。

## 安全注意事项

* **在设置 [CDP API Key](#登录与-cdp-api-key) 之前,CDP 端点是开放的。** 没有 key 时,一次 TCP 连接即获得完整的浏览器控制权。即使设置了 key,也请只把 `9222` 发布到 localhost 或可信网络(或放在 TLS 后面:key 在请求头里传输,纯 HTTP 下是明文)。使用 [host 网络](#host-网络compose)时没有端口映射可以限制它,请设置 `NGINX_LISTEN_ADDR=127.0.0.1`。
* **CDP 网关的隔离 context 继承你真实的登录态。** 每个隔离客户端一开始就登录着主浏览器登录过的所有网站。这正是该功能的目的,也是风险所在:只把 CDP 端点交给你愿意托付这些账号的自动化程序。`/console/` 控制台及其 API 跟随[内置登录](#登录与-cdp-api-key)(跳过登录或 `ENABLE_AUTH=false` 时开放)。web UI 端口上的侧边栏副本(`cdp-console/`)同样跟随内置登录。
* **首次启动后请立即设置登录。** 初始化表单需要容器日志里的设置码,看不到日志的访问者无法占用这个浏览器;但在设置 key 之前 CDP API 仍是开放的。跳过登录意味着任何能访问 web UI 的人都能使用它 —— 而且借助 DNS rebinding(某个网站把自己的域名指向这个容器),该网络里任何用户打开的网页也能使用它:把 `ALLOWED_HOSTS` 设为你访问它所用的主机名即可堵住(IP 地址和 `localhost` 始终可用)。CDP API 本身不受影响(网页能发出的请求它都会拒绝:带 `Origin` 的一律拒,`Sec-Fetch-Site` 不是 `none` 的也拒,DNS rebinding 后的同源 GET 同样包括在内)。web UI 离开可信网络时请同时启用 HTTPS(纯 HTTP 会以明文传输密码和会话 cookie)。
* **网页无法访问 CDP API。** 带 `Origin` 请求头的请求除非 `CDP_ALLOW_ORIGINS` 列出了该 origin,否则一律拒绝;`Sec-Fetch-Site` 不是 `none` 的请求(DNS rebinding 后的同源 GET 也在内)则无条件拒绝。nginx 后面没有任何东西在网页能打开的 TCP 端口上(unix socket,以及用 DevTools 管道代替 DevTools 端口),所以网页 —— 任何浏览器里的,包括容器自己的浏览器 —— 只能经由 nginx 访问这些服务。
* **CDP 客户端只能接触 `CDP_FILE_DIRS` 里的本地文件。** 浏览器以容器用户的身份运行,否则 CDP 客户端可以借它读取该用户能读的任何文件 —— 其中包括 `/browser/settings/auth.json`(给登录会话签名的密钥) —— 还能往它能写的目录里写入新文件(在完成初始化之前写入一个新的 `auth.json` 就能占用登录)。防线有:浏览器里禁止 `file://` URL(`CHROMIUM_ALLOW_FILE_URLS=false`);网关把 CDP 命令里出现的所有路径(文件输入框、拖放、下载目录等)限制在 `CDP_FILE_DIRS` 之内;没有任何 CDP 通道能绕过网关(没有 DevTools 端口,`Target.exposeDevToolsProtocol` 被拒绝)。DevTools 窗口是这样一条通道,除非设置 `CHROMIUM_ALLOW_DEVTOOLS=false`:CDP 客户端不应接触这些文件时请设置它。只有在每个 CDP 客户端都可以读取这些文件时才放宽其他各项。即使会话被盗用,修改登录或 API Key 也需要当前密码。
* 默认情况下 Chromium 以 `--no-sandbox` 运行(Docker 默认的 seccomp 配置禁止它所需的 user namespace —— 容器化 Chrome 的常见情况;以 root 运行,即 `RUN_USER=0` 时,则根本无法启用沙箱)。允许 user namespace 即可启用它的沙箱(`CHROMIUM_SANDBOX`,见[权限降级(`RUN_USER`)](#权限降级run_user));无论哪种情况,都请把容器当作"暴露一个浏览器"来对待,放在专用的用户/VM 里。
* 生成的 TLS 密钥是自签的 —— 浏览器会告警,属预期;对公网服务请换用正式证书。
* PID 1 与 nginx master 以 **root** 运行(入口脚本默认需绑定 80/443 特权端口并准备 profile);桌面栈与 nginx worker 默认以非特权用户 `browser` 运行(`RUN_USER`,见[权限降级(`RUN_USER`)](#权限降级run_user);`RUN_USER=0` 则它们也以 root 运行)。`--security-opt=no-new-privileges` 可直接使用。单独加 `--cap-drop=ALL` 会导致容器无法启动(入口脚本与 nginx 仍需 chown、切换 uid、绑定 80 端口),需加回启动所需的能力:

  ```bash
  docker run --cap-drop=ALL --security-opt=no-new-privileges \
    --cap-add=CHOWN --cap-add=SETUID --cap-add=SETGID --cap-add=NET_BIND_SERVICE \
    --cap-add=FOWNER --cap-add=DAC_OVERRIDE --cap-add=KILL \
    ...   # RUN_USER=0 时不需要最后这三项
  ```

## 故障排查

| 现象                                           | 处理                                                                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curl :9222/json/version` 失败                 | `docker compose logs`;查看容器内 `/tmp/chromium.log`。端口被占?改 `CDP_PORT`。                                                                                                                                          |
| 使用 host 网络时容器反复重启                   | 某个监听端口已被宿主机占用 —— 查看 `docker compose logs` / `/tmp/nginx/error.log`,然后更换 `NGINX_LISTEN_HTTP_PORT`、`NGINX_LISTEN_HTTPS_PORT` 或 `CDP_LISTEN_PORT`。 |
| Web UI 打不开                                  | 是否设了 `ENABLE_SELKIES=false`?查看 `/tmp/nginx/error.log` 及 Selkies 是否起来(其输出在 `docker compose logs` 里)。                                                                                                     |
| 串流里看不到浏览器窗口                         | 是否设了 `CHROMIUM_HEADLESS=1`?默认 `0` 有头并显示在串流桌面。                                                                                                                                                          |
| 隔离 session 报错 `CDP context limit reached`  | 已有 `CDP_CONTEXTS_MAX` 个隔离 context 在运行:关闭空闲的 session(或在 `/console/` 上删除),或者调高上限。网关日志在 `/tmp/cdp-gateway.log`,各 context 的 Chromium 日志在 `$CDP_CONTEXTS_DIR/<context>/chromium.log`(仅在 context 存活期间存在:目录随 context 一起删除,启动失败时也一样 —— 此时原因见网关日志)。     |
| 重启后提示 profile "in use by another process" | 正常情况会自动清理;仍出现就 `rm browser/user-data/Singleton*`。                                                                                                                                                          |
| 旧配置目录语言未生效                           | 入口脚本启动时会预置偏好;确认 `CHROMIUM_LANG` 设在*容器*上,而不是单个页面上。                                                                                                                                           |
| HTTPS 报错                                     | 证书对损坏或不完整时会快速失败 —— 修复或删除 `tls/fullchain.pem` + `tls/privkey.pem`(删掉后重新生成自签对)。                                                                                                                    |

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。欢迎提 issue 和 PR —— 修 bug、完善文档、以及论证充分的特性新增都欢迎。

## 许可证

[MIT](LICENSE) —— 镜像中另行打包了 Chromium、Selkies、nginx 等第三方软件,它们遵循各自的许可证。
