# agentene-browser

**单个 Docker 容器,同时提供 Chrome for Testing 浏览器、可实时观看的远程桌面、以及对外暴露的 CDP 端点。**

[![ci](https://github.com/agentene/browser/actions/workflows/ci.yaml/badge.svg)](https://github.com/agentene/browser/actions/workflows/ci.yaml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![docker image size](https://img.shields.io/docker/image-size/agentene/browser)](https://hub.docker.com/r/agentene/browser)
[![docker pulls](https://img.shields.io/docker/pulls/agentene/browser)](https://hub.docker.com/r/agentene/browser)

[English](README.md) | [简体中文](README.zh-CN.md)

容器在一个入口脚本里拉起全部服务,并作为 PID 1 监管它们:

```
docker run ─┬─ Xvfb        虚拟显示(Selkies 采集的画面;DISPLAY_BACKEND=wayland 时为 labwc)
            ├─ PulseAudio  虚拟音频
            ├─ Selkies     HTML5 远程桌面        ─┐
            ├─ Chrome      for Testing,CDP ───────┼─ nginx 统一门面
            └─ nginx      一个进程,3 个端口     ─┘
```

* **带公开 CDP 端点的 Chromium** — 在容器*外部*用 `connectOverCDP("http://localhost:9222")` 接入 [Playwright](https://playwright.dev) / Puppeteer / Selenium。
* **可实时观看的桌面** — 浏览器默认以**有头模式**运行在虚拟 X11 显示器上,[Selkies](https://github.com/selkies-project/selkies) 2.x 经 WebSocket/WebCodecs 把画面(含音频)串流到任意浏览器(WebRTC 可选)。自动化过程实时可见、可交互。
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
| Xvfb / PulseAudio   | Ubuntu 软件包                | 虚拟显示器 + 音频,供串流                                          |
| labwc               | Ubuntu 软件包                | 无头 Wayland 桌面,可选启用(`DISPLAY_BACKEND=wayland`)             |

容器内部所有服务只监听回环地址;nginx 是唯一的对外门面,且每个代理都支持 WebSocket(CDP 和 Selkies 信令都需要)。

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

修改容器侧端口主要用于 `network_mode: host` / 共享网络命名空间,或 docker 网络里的对端需要特定端口的场景;普通端口发布用默认值即可。它们彼此之间、与 `PORT_FORWARDS` 监听端口、与仅回环的 `SELKIES_INTERNAL_PORT` / `CDP_INTERNAL_PORT`(启用 [CDP 网关](#cdp-网关带登录态的隔离-context)时还有 `CDP_GATEWAY_INTERNAL_PORT`)都不得冲突 —— 冲突时入口脚本直接报错退出。用 `docker run` 时通过 `-e` 传入,并相应调整 `-p`(例如 `-e CDP_LISTEN_PORT=9333 -p 9222:9333`)。

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
* Puppeteer 同样适用:`puppeteer.connect({ browserURL: "http://localhost:9222" })`。

## CDP 网关(带登录态的隔离 context)

*隔离*的 CDP 客户端,包括 Playwright 里的 `browser.newContext()`,以及配置了 `"isolated": true` 的 [playwright-cli](https://github.com/microsoft/playwright-cli) session,通常拿到的是一个空白、只存在于内存里的 context,持久化 profile 里的登录态一个都没有。设置 `ENABLE_CDP_GATEWAY=true` 后,CDP 端口前的网关会为每个这样的 context 提供**一个独立的浏览器**:一个运行在主 profile 克隆上的独立 Chromium。每个隔离 context 一开始就带着主浏览器的全部登录态,而它做的任何操作都不会影响主浏览器,也不会影响其它隔离 context。

```bash
# .env
ENABLE_CDP_GATEWAY=true
```

客户端**无需任何改动**,照常连接 `http://localhost:9222`。例如下面这份 playwright-cli 配置会让每个 `-s=<session>` 都得到一个自己的、带登录态的隔离 context:

```json
{ "browser": { "browserName": "chromium", "isolated": true, "cdpEndpoint": "http://localhost:9222" } }
```

> [!TIP]
> Playwright 会给每个新 context 设置默认 1280×720 的 viewport,页面看到的*屏幕*也随之变成 1280×720,和主浏览器的真实屏幕不一致。有风控的网站(电商、银行等)可能把它当成另一台设备,判定登录异常。在 `browser` 里加上 `"contextOptions": { "viewport": null }`,隔离 context 就会和默认 context 一样使用真实窗口尺寸。

工作原理:

* 开启后,nginx 把 CDP 端口转发给一个小网关(`/usr/local/lib/cdp-gateway/gateway.mjs`)。
* 使用默认 context(`browser.contexts()[0]`)的客户端原样直通到主浏览器,行为不变。
* 客户端新建 context 时,网关自己处理 `Target.createBrowserContext`:
  * 复制 profile,跳过缓存和已打开的标签页(隔离 context 和任何新建 context 一样从零个页面开始)。当 profile 与 `CDP_CONTEXTS_DIR` 位于同一个 XFS 或 btrfs 挂载上时(默认的 `/browser` 布局在这类宿主机上即满足),复制是 reflink(瞬间完成、写时复制),否则是完整复制。网关日志(`/tmp/cdp-gateway.log`)启动时会写明是哪一种;
  * 在副本上启动一个 Chromium;
  * 再从主浏览器把实时 cookie(含 HttpOnly 和会话 cookie)和主浏览器已打开 origin 的实时 localStorage 补写进去,因为 Chromium 写这两样到磁盘都有延迟;
  * 把这个 context 的流量路由到新浏览器。
  * 整个过程约 0.2–0.3 秒。
* context 背后的浏览器与 context 同生共死。关闭 context 或客户端断开(`playwright-cli -s=… close`)即销毁它:结束进程、删除克隆。下一个 session 会得到全新的克隆,因此总是带着主浏览器当前的登录态。
* 每个隔离 context 继承的是它启动那一刻 profile 里的全部内容(cookie、localStorage、IndexedDB、Service Worker、扩展……)。之后主浏览器的变化不会流入正在运行的隔离 context,隔离 context 里的改动也永远不会流回主浏览器。

CDP 控制台在 **`http://localhost:9222/console/`**,和 CDP 在同一端口,处于同一信任边界。主浏览器和每个隔离 context 各占一张卡片:左边是当前 tab 的实时缩略图,标题显示在缩略图底部的半透明横幅里;右边是一个与缩略图等高、可滚动的列表,列出所有打开的 tab,当前 tab 高亮。点列表里的 tab(或缩略图)会让浏览器切换到该 tab,并把窗口提到最前。窗口当前在桌面最前面(也就是 Selkies 画面里看到的)的那个浏览器,卡片会带一圈柔和的辉光,*Show* 按钮的位置换成 *Showing* 标记。卡片实时更新:页面与网关之间保持一条 WebSocket(`/console/ws`),网关只推送变化的部分 —— tab 打开、关闭或改名,当前 tab 切换,新的缩略图(只在有控制台打开时生成;桌面最前面的浏览器最多每 2 秒一张,其他浏览器最多每 20 秒一张)。每张卡片还提供两个操作:

* 「Show」把对应浏览器窗口提到 Selkies 画面最前;
* 「Delete」强制关闭隔离 context 并断开它的客户端。

每个隔离 context 有自己的浏览器边框颜色,与控制台卡片颜色一致,方便在桌面上区分窗口。控制台页面的状态只通过 `/console/ws` WebSocket 获取:连上时先收到一份全量快照,之后只收变化;页面上的操作则是 `/console/api/` 下的普通 HTTP 请求。控制台(以及下面的侧边栏)支持英文和简体中文:默认跟随浏览器语言,标题栏的 *中文* / *EN* 按钮可以切换(按浏览器记住)。

同一个控制台也放在了**实时桌面旁边**:把鼠标移到 Selkies 页面的右边缘,点出现的拉手即可展开(触屏上拉手常显)。拖动侧边栏的左边缘可以调整宽度,最宽为页面宽度的一半或 1000px(取较小者,按浏览器记住),卡片随宽度自适应,空间足够时并排显示。侧边栏提供与 `/console/` 相同的卡片和操作;*Show* 会直接在你正在看的串流里置顶对应窗口。nginx 把侧边栏脚本(`cdp-gateway/panel.js`)注入 Selkies 页面,并把它的 API 和 WebSocket(页面旁的 `cdp-console/`,因此 `SELKIES_SUBFOLDER` 下也能用)代理到网关。设置了 Selkies 登录密码时,两者都要求**主密码**(WebSocket 还只接受同源页面的连接):用只读密码登录的用户看不到拉手。设 `ENABLE_CDP_CONSOLE_PANEL=false` 则完全不改动 Selkies 页面。

**按需启动主浏览器。** 设置 `CHROMIUM_AUTOSTART=false`(必须同时开启网关)后,容器启动时不启动主浏览器,闲置的容器里完全没有 Chromium 进程。由网关在以下时机启动它:

* 有 CDP 客户端连接时(`/json/version`、`/json/new`、浏览器级 WebSocket)。客户端无需改动,第一次连接只是多等浏览器启动的一两秒;
* 在 `/console/` 或 Selkies 侧边栏里点主浏览器卡片上的 **Start browser**。

关闭主浏览器(关掉它的窗口,或点卡片上的 **Stop**)不会让容器退出,只会断开它的 CDP 客户端。**Stop** 的关闭方式与关窗口相同,cookie 和会话会先保存到 profile。列表类请求(`/json/list`)和控制台都不会启动它,所以 `ENABLE_SELKIES=false` 时 compose 的 healthcheck 改为探测 `/json/list`。隔离 context 无需额外处理:它的客户端经由主浏览器连接,会顺带把主浏览器启动起来。

把 `CHROMIUM_IDLE_TIMEOUT` 设为分钟数后,主浏览器空闲满这么久时网关会再次关闭它。空闲指:没有 CDP 客户端连接、没有隔离 context、也没有人在看 Selkies 串流(可能有人正在手动使用浏览器)。关闭方式与 **Stop** 相同,下一个客户端或 *Start browser* 会再把它启动起来。桌面组件(Xvfb 或 labwc、PulseAudio、Selkies)仍然常驻,没有人观看时开销很小。

局限:

* 每个隔离 context 是一个完整的浏览器进程,通常占几百 MB 内存。`CDP_CONTEXTS_MAX` 限制同时运行的数量;超出上限时,新建 context 会返回明确的 CDP 错误。
* CDP 协议里不带 session 名,所以一个隔离 context 绑定一个连接。用同一个名字重新打开 playwright-cli session,得到的是新的隔离 context,而不是原来那个。
* 只有一个连接上的*第一个*隔离 context 会获得独立的 profile 克隆浏览器。同一连接上再调用 `browser.newContext()`,得到的是该浏览器内部的普通无痕 context,不带登录态;需要另一个带登录态的 context 时请新开一个连接。
* 需要全新 context 才能生效的 context 选项(例如按 context 设置的 `proxy`)对隔离 context 不起作用,它沿用主浏览器的设置。

## 观看桌面

打开 <http://localhost:8080>。Selkies 把虚拟显示器画面(含音频)直接串流到浏览器标签页 —— 键盘鼠标输入会送进容器。Chromium 默认有头运行(`CHROMIUM_HEADLESS=0`),每一步自动化都能在串流里看到。可用 `CHROMIUM_LANG` / `CHROMIUM_START_URL` 控制浏览器初始状态。

设置密码(`SELKIES_BASIC_AUTH_PASSWORD`,用户名默认 `ubuntu`,见[环境变量](#环境变量))即可为串流启用登录页。

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

## 配置

全部通过环境变量配置;使用 Compose 时写入 `.env`(模板见 [.env.example](.env.example))。未在 `compose.yaml` 里显式列出的变量也会经 `env_file` 直通进容器 —— 包括 Selkies 原生设置,如 `SELKIES_FRAMERATE=30`、`SELKIES_TURN_URL=...`。

### 构建参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `CHROME_VERSION` | `156.0.8078.47` | [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) 版本(默认钉 Stable 通道;CfT known-good 列表中的任意版本均可) |
| `NODE_VERSION` | `24` | Node.js 主版本(由 [`update-chrome-node.mjs`](#版本联动脚本) 保持同步) |
| `SELKIES_VERSION` | `2.1.0` | Selkies 上游 release;其 wheel 及 pixelflux/pcmflux 依赖 wheel 从 GitHub release 下载,摄像头/手柄 interposer 由同一 tag 的源码编译(见 `Dockerfile`) |
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

**Web UI / TLS**

| 变量                             | 默认值                                        | 说明                                                                                                                                                             |
| -------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NGINX_LISTEN_HTTP_PORT`         | `80`                                          | nginx 在容器内提供 HTTP Web UI 的端口(见[端口](#端口))                                                                                                           |
| `NGINX_LISTEN_HTTPS_PORT`        | `443`                                         | nginx 在容器内提供 TLS Web UI 的端口                                                                                                                             |
| `NGINX_LISTEN_ADDR`              | *(空)*                                        | 所有 nginx 监听(Web UI、CDP、`PORT_FORWARDS`)绑定的地址;空 = 所有网卡。使用 [host 网络](#host-网络compose)时建议设为 `127.0.0.1`,让 CDP 与 Web UI 只在本机可访问 |
| `ENABLE_HTTPS`                   | `false`                                       | `true` = nginx 在容器 `NGINX_LISTEN_HTTPS_PORT` 端口同时提供 TLS 的 Web UI                                                                                       |
| `TLS_CERT_DIR`                   | `/etc/nginx/tls`                              | 证书查找 / 生成目录                                                                                                                                              |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | `$TLS_CERT_DIR/fullchain.pem` / `privkey.pem` | 显式证书/私钥路径                                                                                                                                                |
| `TLS_SELF_SIGNED_CN`             | `localhost`                                   | 生成的自签证书 CN                                                                                                                                                |

**额外端口转发**

| 变量            | 默认值 | 说明                                                                                                                                                                                                    |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT_FORWARDS` | *(空)* | 空格/逗号分隔的 `LISTEN=HOST:PORT` 列表:nginx 额外监听每个 `LISTEN` 端口,反向代理(支持 WebSocket)到 `HOST:PORT` —— 通常是同一 docker 网络里的兄弟容器。详见 [Docker 网络(compose)](#docker-网络compose) |

**Selkies**

| 变量                          | 默认值    | 说明                                                      |
| ----------------------------- | --------- | --------------------------------------------------------- |
| `SELKIES_BASIC_AUTH_PASSWORD` | *(空)*    | 设置即启用登录页;空 = 无登录                              |
| `SELKIES_BASIC_AUTH_USER`     | `ubuntu`  | 登录用户名                                                |
| `SELKIES_ENCODER`             | `h264enc` | `h264enc` \| `h264enc-striped` \| `openh264enc` \| `jpeg` |
| `SELKIES_EXTRA_ARGS`          | *(空)*    | 追加到 `selkies` 的额外 CLI 参数                          |
| `SELKIES_ENABLE_RESIZE`       | `false`   | `true` = 由浏览器驱动调整分辨率:虚拟显示器跟随观看端浏览器窗口大小(X11 下的余量见 `SCREEN_GEOMETRY_MAX`) |
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
| `SELKIES_INTERNAL_PORT`       | `8081`    | Selkies 绑定的回环端口(nginx 后面)                        |

**Chromium / CDP**

| 变量                        | 默认值                                                                                              | 说明                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHROMIUM_HEADLESS`         | `0`                                                                                                 | `0` = 有头,显示在桌面上(Xvfb 或 labwc,串流可见);`1` = 无头                                                                                                                                  |
| `CHROMIUM_LANG`             | `en-US`                                                                                             | 浏览器 UI 语言 + `Accept-Language`(如 `zh-CN`)                                                                                                                                    |
| `CHROMIUM_START_URL`        | `about:blank`                                                                                       | 启动时打开的页面                                                                                                                                                                  |
| `CHROMIUM_AUTOSTART`        | `true`                                                                                              | `false` = 容器启动时不启动主浏览器(需 `ENABLE_CDP_GATEWAY=true`):首个 CDP 客户端连接或在 CDP 控制台点 *Start browser* 时才启动,关闭它也不会让容器退出([详情](#cdp-网关带登录态的隔离-context)) |
| `CHROMIUM_IDLE_TIMEOUT`     | `0`                                                                                                 | 配合 `CHROMIUM_AUTOSTART=false`:主浏览器空闲(无 CDP 客户端、无隔离 context、无人观看串流)多少分钟后自动关闭;`0` = 不自动关闭 |
| `CHROMIUM_DEVICE_INTERPOSERS` | `true` | 把 Selkies 的摄像头 + 手柄 interposer(以及 fake-udev,镜像构建时从 Selkies 源码编译)预加载进浏览器(含隔离 context):观看端摄像头显示为 *Selkies Virtual Camera*,手柄出现在 Gamepad API 中,无需 `/dev/video*`、`/dev/uinput` 或特权。仅在 `ENABLE_SELKIES=true` 时生效;`false` = 不预加载 |
| `CHROMIUM_EXTRA_ARGS`       | *(空)*                                                                                              | 额外 chromium 参数,如 `--proxy-server=http://host:3128`                                                                                                                           |
| `CHROMIUM_GPU`              | `auto`                                                                                              | `auto` = 有直通 GPU(见 [GPU 直通](#gpu-直通可选))就用硬件渲染,否则 SwiftShader 软件渲染 —— WebGL 始终可用;`off` = 强制软件渲染;`strict` = 永不允许 SwiftShader(无 GPU 则无 WebGL) |
| `CHROMIUM_DISABLE_FEATURES` | `HttpsFirstBalancedModeAutoEnable,HttpsUpgrades,HttpsFirstModeV2`(compose 默认;不用 compose 时为空) | 逗号分隔的特性列表,以 `--disable-features=` 传给 chromium —— 关闭 HTTPS-First / HTTPS-Upgrade 实验;在 `.env` 里设为空可去掉该参数                                                 |
| `CHROMIUM_USER_DATA_DIR`    | `/browser/user-data`                                                                                | 浏览器配置目录(位于 `/browser` 挂载内,见[持久化](#持久化));在 `.env` 中覆盖时请保持在该挂载内                                                                                                                                                         |
| `CDP_LISTEN_PORT`           | `9222`                                                                                              | 公开 CDP 端点在容器内的端口(nginx → chromium,或 → CDP 网关;见[端口](#端口))                                                                                                                     |
| `CDP_INTERNAL_PORT`         | `9221`                                                                                              | Chromium 回环 DevTools 端口(nginx 后面)                                                                                                                                           |

**CDP 网关**(见 [CDP 网关](#cdp-网关带登录态的隔离-context))

| 变量                        | 默认值                      | 说明                                                                                                                                    |
| --------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_CDP_GATEWAY`        | `false`                     | `true` = 每个隔离的 CDP context 都获得一个运行在主 profile 克隆上的独立 Chromium(继承登录态,不回写);CDP 控制台在 CDP 端口的 `/console/` |
| `CDP_CONTEXTS_MAX`          | `4`                         | 同时存在的隔离 context 上限(每个都是完整浏览器);超出后新建 context 返回 CDP 错误                                                        |
| `CDP_CONTEXTS_HEADLESS`     | 与 `CHROMIUM_HEADLESS` 相同 | `1` = context 浏览器无界面运行;`0` = 有界面,显示在桌面上(串流里可见)                                                                    |
| `CDP_CONTEXTS_DIR`          | `/browser/contexts`         | 每个隔离 context 的浏览器(profile 克隆)存放目录;每次启动清空,不得位于 `CHROMIUM_USER_DATA_DIR` 之内;与 profile 放在同一挂载上,克隆才能用 reflink               |
| `CDP_GATEWAY_INTERNAL_PORT` | `9220`                      | 网关回环端口(nginx 后面)                                                                                                                |
| `ENABLE_CDP_CONSOLE_PANEL`  | `true`                      | 网关和 Selkies 都启用时:在 Selkies 页面右边缘加一个 CDP 控制台侧边栏(设置了 Selkies 登录时需要主密码);`false` = 不加侧边栏 |

**桌面 / 容器**

| 变量                | 默认值         | 说明                                                                                                                                                                                                                 |
| ------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TZ`                | `UTC`          | 容器时区(任意 IANA 时区,如 `Asia/Shanghai`)                                                                                                                                                                          |
| `DISPLAY_BACKEND`   | `x11`          | 有头浏览器所在的桌面:`x11` = Xvfb(+ picom);`wayland` = labwc,一个无头 Wayland 合成器 + 窗口管理器,由 Selkies 在 GPU 上采集 —— 挂了 GPU 时,动画页面的 CPU 占用降低数倍,见 [Wayland 桌面](#wayland-桌面display_backendwayland)。下方标注 *仅 X11* 的四项对 `wayland` 不生效 |
| `SCREEN_GEOMETRY`   | `1920x1080x24` | Xvfb 屏幕尺寸 `宽x高x深`(`wayland` 时为 labwc 输出的尺寸);同时决定 Selkies 串流分辨率                                                                                                                                 |
| `SCREEN_GEOMETRY_MAX` | `8192x4096x24` | *仅 X11。* Xvfb 创建屏幕时的 RandR 上限 `宽x高x深`,使 Selkies 动态分辨率(浏览器窗口大小 → 虚拟显示器分辨率,需 `SELKIES_ENABLE_RESIZE=true`)可以超过 `SCREEN_GEOMETRY` 向上调整;启动时再把工作尺寸经 RandR 预设回来。留空 = 固定为 `SCREEN_GEOMETRY` 的屏幕(大于该尺寸的浏览器窗口只能被裁切显示) |
| `DISPLAY`           | `:0`           | *仅 X11。* Xvfb 的 display;若该编号在当前网络命名空间里已被占用(在跑着 X/Xwayland 的机器上使用 host 网络),自动换用下一个空闲编号并记录日志                                                                                      |
| `ENABLE_COMPOSITOR` | `true`         | *仅 X11。* 在 Xvfb 显示器上运行合成器(picom),让 Chromium 的弹出菜单(右键菜单)保留投影 —— 没有合成器时菜单会渲染成看似无边框的白色贴片;`false` = 恢复旧的扁平外观                                                                |
| `CHROMIUM_FOLLOW_SCREEN` | `true` | *仅 X11*(labwc 自己保持窗口最大化)。屏幕尺寸改变时(Selkies 按浏览器窗口动态调整分辨率,见 `SCREEN_GEOMETRY_MAX`)让有头 Chromium 窗口始终铺满整个显示器 —— Xvfb 上没有窗口管理器,否则窗口保持启动时的尺寸(屏幕变大时周围是黑边,变小时被裁切);只调整浏览器主窗口,弹出窗口和独立的 DevTools 窗口保持各自尺寸;`false` = 窗口保持启动时的样子 |
| `PIXELFLUX_HOST_CAPTURE` | `zwlr` | *仅 Wayland*(pixelflux 原生设置)。Selkies 采集 labwc 的方式:`zwlr` = wlr-screencopy;其他任意值(如 `auto`)让 pixelflux 优先用 ext-image-copy-capture,而 labwc 无法导入它分配的 GPU 缓冲 —— 有 GPU 时串流根本起不来 |
| `RUN_USER`          | *(空)*         | 桌面栈(Xvfb 或 labwc、picom、PulseAudio、selkies、chromium、CDP 网关)与 nginx *worker* 以该用户而非 root 运行 —— 已存在的用户名(如 `browser`)或 `uid[:gid]`;PID 1 与 nginx master 保持 root。见[权限降级(`RUN_USER`)](#权限降级run_user) |

### 权限降级(`RUN_USER`)

默认情况下容器内所有进程都以 root 运行(历史行为)。设置 `RUN_USER` 把
桌面栈 —— Xvfb(或 labwc)、picom、PulseAudio、selkies、chromium(以及 CDP 网关和它的
context 浏览器),还有 nginx 的 *worker* —— 迁移到非特权用户:

```bash
# compose(.env)
RUN_USER=browser       # 或数字 uid[:gid],例如 1000,与宿主机上
                       # ./browser 的属主 uid 对齐
```

具体行为:

* 接受已存在的用户名(镜像内置 `browser`,uid 1001)或 `uid[:gid]`;数字 id 缺失的 passwd/group 条目会在启动时合成。
* PID 1 与 nginx **master** 保持 root:nginx 绑定(默认为特权的)监听端口并读取 TLS 密钥,监督进程负责准备浏览器 profile。其余进程经 `setpriv` 以无 capability 状态启动。
* 浏览器 profile(`CHROMIUM_USER_DATA_DIR`)每次启动都会 `chown` 给该用户 —— 首次迁移较大的 root 属主 profile 需要一点时间,之后只是空遍历。
* GPU 设备节点保持可用:`/dev/dri` / NVIDIA 节点的宿主机 gid 会被加入补充组。
* 刻意**不**改变的:chromium 仍带 `--no-sandbox`(Docker 默认 seccomp 对任何 uid 都不允许 userns 沙箱),CDP/web 端口保持不变。收益是文件系统/权限隔离 —— 浏览器被攻破后不再能以 root 写文件。

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

entrypoint 启动时自动探测设备(`CHROMIUM_GPU=auto` 为默认)并把 Chromium 切到 Vulkan/ANGLE 后端(`--use-angle=vulkan --enable-features=Vulkan`):WebGL/WebGPU 上下文经 Vulkan 渲染(原生 GL 路径在 Xvfb 上根本走不通),显示合成器也跑在 Vulkan 上(不开启合成标志时,chrome://gpu 会把 WebGL 标为 "Hardware accelerated but at reduced performance"—— GPU 帧被回读进 CPU 合成器)。实测:NVIDIA 直通 → `ANGLE (NVIDIA, Vulkan … GeForce RTX …)`;AMD 核显 → `ANGLE (AMD, Vulkan … RADV)`,`webgl/webgpu: enabled`(无回读)。此时无头模式也不再追加 `--disable-gpu`,SwiftShader 仍作为运行时兜底保留,设备中途出错 WebGL 不断供。`CHROMIUM_GPU=strict` 永不允许 SwiftShader(反指纹:浏览器不得上报软件渲染器,无 GPU 时 WebGL 不可用);`off` 即使挂了 GPU 也强制走软件路径。

镜像内置了 Intel/AMD 的 Mesa/VA-API 用户态;NVIDIA 的 GL 库无法内置(必须与宿主机驱动版本匹配)—— 由 nvidia container toolkit 在容器启动时注入。验证方式:`docker compose exec browser glxinfo -B` / `vainfo`(Intel/AMD)或 `nvidia-smi`(NVIDIA),再在串流的浏览器里打开 `chrome://gpu`,WebGL 应显示硬件渲染器。[`examples/webgl-renderer-probe.mjs`](examples/webgl-renderer-probe.mjs) 无需任何依赖即可打印 WebGL 渲染器和 `chrome://gpu` 的特性状态:默认连接回环 DevTools 端口 `127.0.0.1:9221`(在容器内运行,例如先 `docker cp` 进去),也可以用 `node examples/webgl-renderer-probe.mjs localhost 9222` 指向公开端点。

### Wayland 桌面(`DISPLAY_BACKEND=wayland`)

挂了 Intel/AMD GPU 时,对于一切会动的内容(视频、canvas、轮播图 —— 例如 baidu.com 首页的 logo 就是一段循环播放的视频),Wayland 桌面比 Xvfb 省得多。在 Xvfb 上,浏览器窗口的每一帧都要从 GPU 读回、再经单线程的软件 X server 拷贝一遍,Selkies 还要再拷出来一遍;一个动画页面就能让 Xvfb 吃满约一个 CPU 核,而它一旦饱和,所有窗口和串流都会跟着变慢。设置

```bash
# .env
COMPOSE_FILE=compose.yaml:compose.gpu.yaml
DISPLAY_BACKEND=wayland
```

后,浏览器运行在 [labwc](https://labwc.github.io/)(一个无头 Wayland 合成器 + 窗口管理器)里,Selkies 通过 screencopy 采集它的输出:帧从 Chromium 到 VA-API 编码器全程留在 GPU 上(dmabuf 零拷贝)。在 AMD 核显(Renoir)、1920x1200、打开 baidu.com 首页时实测的整个容器 CPU 占用:

| | `x11` | `wayland` |
| --- | --- | --- |
| 无人观看 | 107% | 17% |
| 有一个 Selkies 观看端连接 | 335%(Xvfb 饱和) | 29% |

开启后的变化:

* 浏览器窗口由 labwc 最大化,保留标签栏和地址栏,并且始终锁定:只显示关闭按钮,双击/中键标签栏空白处无效,拖动窗口或窗口边缘(包括 Alt+拖动)都无法移动或调整大小,标签栏右键菜单里的「最小化」/「恢复」会在不到一秒内被撤销(负责撤销的监视进程在没有窗口时休眠,空桌面不占 CPU);弹出窗口和右键菜单由合成器原生合成(不需要 picom)。Alt+Tab 切换窗口;CDP 控制台的 *Show* 通过 labwc 把窗口提到最前。
* labwc 自己的 60 Hz 帧时钟驱动浏览器,不论是否有人在看串流;被其他窗口挡住的窗口也照常渲染,所以自动化的行为与 Xvfb 上一致。
* 鼠标指针只由 Selkies 客户端在本地绘制,没有串流延迟(labwc 自己的指针不进入视频画面 —— 否则它会延迟跟随,形成第二个"重影"指针)。指针始终是箭头:screencopy 不携带光标形状,所以不像 `x11` 那样有文本/手形光标。
* Selkies 按浏览器窗口调整分辨率(`SELKIES_ENABLE_RESIZE=true`)时调整的是 labwc 的输出;不开启时输出保持 `SCREEN_GEOMETRY`。
* Chromium 走它原生的 Wayland/EGL 路径,不使用上面的 Vulkan 标志(Chromium 不支持 Wayland 下的 Vulkan)。
* Selkies 通过 wlr-screencopy 采集 labwc(`PIXELFLUX_HOST_CAPTURE=zwlr`,由入口脚本设置)。labwc 也提供更新的 ext-image-copy-capture,pixelflux 会优先用它,但 labwc 无法导入 pixelflux 为它分配的 GPU 缓冲区,挂了 GPU 时串流根本起不来;设成其他任意值(如 `auto`)就把选择权交还给 pixelflux。

不起作用的情况:没有 GPU 时两种方式都纯软件渲染,开销与 `x11` 基本相同(CI 里的 `wayland` 冒烟测试就是这样跑的);使用 **NVIDIA** 时,注入的驱动栈在 Wayland 下给不了 Chromium GPU 合成 —— 这种情况请保持默认的 `x11`(入口脚本会给出警告)。

## 持久化

| 宿主路径(compose)      | 容器路径               | 内容                                                           |
| ---------------------- | ---------------------- | -------------------------------------------------------------- |
| `./browser/user-data`  | `/browser/user-data`   | Chromium 配置:cookies、登录态、扩展、`navigator.language` 偏好 |
| `./browser/contexts`   | `/browser/contexts`    | [CDP 网关](#cdp-网关带登录态的隔离-context)的浏览器 context,各自一份 profile 克隆(每次启动清空) |
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

转发由同一个 nginx 前门提供(无额外进程):支持 WebSocket;经容器的 DNS 服务器(compose 网络下即 docker 内嵌 DNS)按请求解析对端 —— 对端容器还没起来时本容器照常启动(对端上线前请求返回 502),对端重建换 IP 后也能自动跟上。转发监听端口不得与 `NGINX_LISTEN_HTTP_PORT` / `NGINX_LISTEN_HTTPS_PORT` / `CDP_LISTEN_PORT`(默认 80/443/9222)、仅回环的内部端口(`SELKIES_INTERNAL_PORT` 8081、`CDP_INTERNAL_PORT` 9221、启用网关时的 `CDP_GATEWAY_INTERNAL_PORT` 9220)或其他转发端口冲突 —— 冲突时入口脚本拒绝启动。

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
* 仅回环的内部端口 —— `SELKIES_INTERNAL_PORT`(8081)、`CDP_INTERNAL_PORT`(9221),以及开启 `ENABLE_CDP_GATEWAY=true` 时的 `CDP_GATEWAY_INTERNAL_PORT`(9220)—— 同样占用宿主机回环(context 浏览器自行选择空闲端口)。若与你自己的应用冲突,在 `.env` 里换掉;端口绑定失败会导致容器退出。
* `NETWORK_NAME` / `NETWORK_EXTERNAL` 与 `hostname` 不再生效。`PORT_FORWARDS` 仍可用,但通过宿主机的 DNS 解析(容器名无法解析)—— 通常直接让浏览器访问 `localhost:<端口>` 即可。
* 若宿主机自己在 `:0` 上跑着 X server,入口脚本会自动换用下一个空闲 display。Xvfb 只监听文件系统 socket,宿主机进程无法接入容器里无认证的 display。

## 服务开关、健康检查与重启

* 容器启动 == 服务启动:入口脚本是一个极简 PID 1 监管器,**任一服务退出即退出**,配合 `--restart always` / `restart: always` 即为自动恢复。
* compose 健康检查每 30 秒轮询 `http://127.0.0.1:${NGINX_LISTEN_HTTP_PORT}/`(nginx 代理 Selkies):2xx、重定向(`SELKIES_SUBFOLDER`)或 401(开启了登录页)都视为健康,502(Selkies 未就绪)不算。`ENABLE_SELKIES=false` 时没有 Web 监听,改为探测 `http://127.0.0.1:${CDP_LISTEN_PORT}/json/version`。直接 `docker run` 没有健康检查(镜像本身未定义)。
* 同时设置 `ENABLE_SELKIES=false` 和 `ENABLE_CDP=false` 是配置错误,会立即失败。
* 日志在容器内 `/tmp/*.log`(`xvfb.log` 或 `labwc.log`、`picom.log`、`pulseaudio.log`、`chromium.log`、`cdp-gateway.log`、`nginx/*.log` 等);`docker compose logs` 显示入口脚本自身以及 Selkies、nginx 的输出。

## 从源码构建

```bash
docker compose build            # 或:docker build -t agentene/browser .
```

单阶段 Dockerfile,各部分各自成层地安装:Node.js、Chrome for Testing 及其系统依赖、nginx、Xvfb/PulseAudio/labwc、Selkies 官方 release wheel,以及 CDP 网关的 npm 依赖(按 lockfile `npm ci`)。Chrome 直接从 Chrome for Testing 官方存储桶下载(不经过 Playwright);Selkies 及其 `pixelflux`/`pcmflux` 依赖从各自的 GitHub release 下载。

`docker build --check .` 通过,无警告。

## 版本联动脚本

[`update-chrome-node.mjs`](update-chrome-node.mjs) 基于实时元数据([Chrome for Testing 版本源](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json)的 Stable 通道 + Node.js 发布索引中最新的 LTS 主版本)统一重钉 `Dockerfile`、`compose.yaml`、`.env.example` 以及两个 README 构建参数默认值表格中的 Chrome 与 Node 版本。Chrome 版本必须提供 `linux64` 构建:

```bash
node update-chrome-node.mjs                  # 钉到最新的 Stable Chrome for Testing
node update-chrome-node.mjs <version>        # 钉到指定的 known-good 版本
node update-chrome-node.mjs --check          # 偏差检查:有偏差则退出码 1,不改任何文件
node update-chrome-node.mjs --node 22        # 强制指定 Node 主版本,而不是最新 LTS
```

## CI/CD 与发布的镜像

[![ci](https://github.com/agentene/browser/actions/workflows/ci.yaml/badge.svg)](https://github.com/agentene/browser/actions/workflows/ci.yaml)

每个 pull request 以及每次推送到 `main` 都会运行 [`ci.yaml`](.github/workflows/ci.yaml):静态检查(hadolint、`docker build --check`、shellcheck、`node --check`、`py_compile`)、完整镜像构建、运行时冒烟测试(CDP 端点、Web UI、CDP 网关、Wayland 桌面)。推送 `v*` 标签(或手动运行该 workflow)时构建并发布 `linux/amd64` 镜像(Dockerfile 只支持这一种架构):

* **GHCR**:`ghcr.io/agentene/browser`(使用内置 `GITHUB_TOKEN`)
* **Docker Hub**:`agentene/browser`(与 GHCR 同为 `<owner>/<repo>` 路径;需要仓库 secrets `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`,且该账号有权推送到此命名空间;未配置则跳过)

标签规则(标签与 Chrome 版本对齐):`v150.0.7871.100` → `150.0.7871.100`、`150`、`sha-<短哈希>`、`latest`。手动运行 workflow(无标签)时只发布 `sha-<短哈希>` 标签。

### 上游版本自动更新

[`chrome-update.yaml`](.github/workflows/chrome-update.yaml) 每天定时(也支持手动触发)监视 Chrome for Testing 版本源中新的 Stable 版本,并驱动整个闭环:

1. `update-chrome-node.mjs` 重新钉住仓库中的 Chrome 与 Node 版本;
2. 自动开启一个包含变更 diff 的 bump PR;
3. `ci.yaml` 在该 PR 上运行(lint + 完整构建 + 冒烟测试);
4. CI 全绿后 PR 以 squash 方式自动合并;
5. `ci.yaml` 中的 `release-tag` job 推送标签 `v<chrome 版本>`;
6. 标签事件触发 `publish` job → 镜像发布到 GHCR / Docker Hub。

若 `v150.0.7871.100` 已被占用(同一 Chrome 版本重新发布),标签自动递增为 `v150.0.7871.100-r2`、`-r3`、……

要实现全自动,需一次性配置:

* **仓库 secret `CHROME_UPDATE_TOKEN`** —— 经典 PAT(需 `repo` 权限)或 fine-grained PAT(需 *Contents* + *Pull requests* 读写)。它在两处不可或缺:GitHub 对用内置 `GITHUB_TOKEN` 创建的 PR 绝不触发 `on: pull_request`(bump PR 将没有 CI 检查);且 `GITHUB_TOKEN` 产生的事件不会触发任何 workflow(用它推送的发布标签永远不会启动 publish job)。不配置该 secret 时 bump PR 照常开启、等待人工合并(关闭再重开该 PR 可强制触发 CI),但推送的标签不会自动发布 —— 需在本机重推标签或手动运行 workflow。
* **Settings → General → Pull Requests → "Allow auto-merge"** 打开,PR 才能在检查通过后自行合并。

不配置 secret 时流程仍然完整,只是加了人工闸门:PR 照常开启,你验证后手动合并,打标签与发布随后自动完成。手动 `v*` 标签的发布方式完全不变;手动改 Chrome 版本合入 main 也会同样被自动打标签并发布。

## 安全注意事项

* **CDP 端点没有认证。** 一次 TCP 连接即获得完整的浏览器控制权 —— `9222` 只发布到 localhost 或可信网络,绝不要暴露公网 IP。使用 [host 网络](#host-网络compose)时没有端口映射可以限制它,请设置 `NGINX_LISTEN_ADDR=127.0.0.1`。
* **CDP 网关的隔离 context 继承你真实的登录态。** 设置 `ENABLE_CDP_GATEWAY=true` 后,每个隔离客户端一开始就登录着主浏览器登录过的所有网站。这正是该功能的目的,也是风险所在:只把 CDP 端点交给你愿意托付这些账号的自动化程序。`/console/` 控制台及其 API 与 CDP 端口一样没有认证。web UI 端口上的侧边栏副本(`cdp-console/`)则跟随 Selkies 登录:只认主密码,web UI 未设登录时则不鉴权。
* **Web UI 默认无认证。** 只要串流可能被不信任的人访问,就设置 `SELKIES_BASIC_AUTH_PASSWORD`;同时配合 HTTPS(纯 HTTP + basic auth 会泄露密码)。
* Chromium 以 `--no-sandbox` 运行(容器化 Chrome 在没有允许 userns 的 seccomp 配置时的标准做法);请把容器当作"暴露一个浏览器"来对待,放在专用的用户/VM 里。
* 生成的 TLS 密钥是自签的 —— 浏览器会告警,属预期;对公网服务请换用正式证书。
* 容器默认以 **root** 运行(入口脚本是 PID 1,且默认需绑定 80/443 特权端口)。设置 `RUN_USER`(见[权限降级(`RUN_USER`)](#权限降级run_user))可把桌面栈与 nginx worker 移出 root —— PID 1 与 nginx master 按设计保持 root。`--security-opt=no-new-privileges` 可直接使用。单独加 `--cap-drop=ALL` 会导致容器无法启动(入口脚本与 nginx 仍需 chown、切换 uid、绑定 80 端口),需加回启动所需的能力:

  ```bash
  docker run --cap-drop=ALL --security-opt=no-new-privileges \
    --cap-add=CHOWN --cap-add=SETUID --cap-add=SETGID --cap-add=NET_BIND_SERVICE \
    ...   # 使用 RUN_USER 时还需: --cap-add=FOWNER --cap-add=DAC_OVERRIDE --cap-add=KILL
  ```

## 故障排查

| 现象                                           | 处理                                                                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curl :9222/json/version` 失败                 | `docker compose logs`;查看容器内 `/tmp/chromium.log`。端口被占?改 `CDP_PORT`。                                                                                                                                          |
| 使用 host 网络时容器反复重启                   | 某个监听端口或内部端口已被宿主机占用 —— 查看 `docker compose logs` / `/tmp/nginx/error.log`、`/tmp/chromium.log`,然后更换 `NGINX_LISTEN_HTTP_PORT`、`CDP_LISTEN_PORT`、`SELKIES_INTERNAL_PORT`、`CDP_INTERNAL_PORT` 或 `CDP_GATEWAY_INTERNAL_PORT`。 |
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
