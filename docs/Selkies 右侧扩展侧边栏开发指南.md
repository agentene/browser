# Selkies 右侧扩展侧边栏开发指南

Oct 27, 2026 · @Chen Define

## 背景与目标

结论：不修改 selkies 及其依赖库源码，可以在 selkies web 界面右侧加一个点击后弹出的侧边栏，用来配置系统程序。推荐做法是在 selkies 前面加一层 nginx 反向代理，用 `sub_filter` 往入口页注入一个外置脚本，再配一个自建的配置后端。

**需求**

- selkies 现有的左侧侧边栏不变：鼠标移到左侧，点红色拉手弹出，用来调 selkies 自己的配置。
- 在右侧新增一个同样的拉手和侧边栏，用来配置宿主机或容器里的某些系统程序（读写配置文件、重启服务、查看状态等）。

**约束**

- 不修改 selkies 仓库和它的依赖库（pixelflux、pcmflux 等）的任何源码，也不维护 fork。
- selkies 升级时，扩展最好不用跟着改，或者只需要很少的改动。

**分析基线**：selkies-project/selkies 主分支提交 `e7746b0`（2026-10-26）。下文所有行号都对应这个提交，selkies 升级后要按「升级维护」一节重新核对。

**适用读者**：负责实现和维护这个扩展的前端、后端和运维工程师。

## Selkies 前端架构分析

selkies 的串流核心（core）和界面（dashboard）是分开的两层。它们之间只通过同源 `window.postMessage` 和几个 `window` 全局变量通信，所以一段同源注入的脚本能拿到和左侧侧边栏一样的能力。

### 页面组成

| 部分 | 源码位置 | 作用 |
| --- | --- | --- |
| core | `addons/selkies-web-core/`（入口 `selkies-core.js`，WebSocket 模式 `selkies-ws-core.js`，WebRTC 模式 `selkies-wr-core.js`，输入处理 `lib/input.js`） | 解码画面、采集键鼠、和服务端的 WebSocket / WebRTC 通信 |
| 经典 dashboard | `addons/selkies-dashboard/`（React） | 左侧侧边栏、状态条等界面。默认打包进 wheel 的就是它 |
| wish dashboard | `addons/selkies-dashboard-wish/` | 另一套界面实现，和经典 dashboard 用同一个 core |

构建脚本 `scripts/ci/build-web.sh` 会把经典 dashboard 的 `dist` 和 `selkies-core.js` 拷贝到 `src/selkies/selkies_web`，作为 Python 包数据随 wheel 一起发布。入口 `index.html` 里挂着 `#app`、`#root`、`#touch-gamepad-host` 三个容器。

### core 与 dashboard 的通信协议

- **dashboard 发给 core**：`window.postMessage({type, ...}, window.location.origin)`。常见的 `type` 有 `settings`、`pipelineControl`、`setManualResolution`、`resetResolutionToWindow`、`clipboardUpdateFromUI`、`requestFullscreen`、`gamepadControl`、`command` 等。
- **core 发给 dashboard**：同样是 `postMessage`，常见的有 `pipelineStatusUpdate`、`serverSettings`、`clipboardContentUpdate`、`fileUpload`、`gamepadButtonUpdate` 等。
- **全局变量**：core 会把 `window.fps`、`window.system_stats`（服务端 CPU 和内存）、`window.gpu_stats`、`window.currentAudioBufferSize` 等挂在 `window` 上，dashboard 定时去读。
- **同源限制**：core 收消息时会先执行 `if (event.origin !== window.location.origin) return;`。所以扩展脚本必须和 selkies 页面同源，这也是推荐「注入到同一页面」而不是「跨域 iframe」的原因之一。

完整的消息说明见 `addons/selkies-dashboard/README.md`。

### 左侧侧边栏是怎么实现的

红色拉手是 `Sidebar.jsx` 里 `className='toggle-handle'` 的元素，样式在 `src/styles/Overlay.css`：`position: fixed; left: 0; top: 50%`，宽 15px、高 60px（iOS 上 35px 宽，避开系统手势区），`z-index: 1020`。dashboard 里最高的 `z-index` 是 `9999`。右侧扩展可以照着这个尺寸和交互做，保持左右一致。

### 键盘白名单：`allow-native-input`

这是右侧面板能不能正常用的关键。core 在 `window` 的捕获阶段监听 `keydown` / `keyup`，把按键转发到远程桌面，并阻止浏览器的默认行为。如果不处理，在面板输入框里打字，字符会出现在远程桌面上。

- `lib/input.js:82` 定义 `const WHITELIST_CLASS = 'allow-native-input';`。
- `_handleKeyDown`（`lib/input.js:2194`）和 `_handleKeyUp`（`lib/input.js:2404`）会先调用 `_targetHasClass(event.target, WHITELIST_CLASS)`，命中就直接 `return`，按键留给浏览器。
- `_targetHasClass`（`lib/input.js:5301`）会沿 `parentElement` 一路往上找，所以只要面板**根元素**带上这个 class，里面所有控件都生效。
- 用 Shadow DOM 时，`window` 捕获阶段看到的 `event.target` 会被重定向到 shadow host。class 放在 host 上就能生效。

有一个例外：`Ctrl+Shift+M`、`Ctrl+Shift+F`、`Ctrl+Shift+X`、`Ctrl+Shift+G` 这几个 selkies 热键在白名单判断**之前**就被处理了，面板里也会触发。面板不要再绑定这几个组合键。

### 静态文件与部署相关的服务端行为

| 机制 | 位置 | 对扩展的影响 |
| --- | --- | --- |
| `web_root` 参数 | `stream_server.py:3480` | 指向一个含 `index.html` 的目录就会代替打包的前端；否则把包内 `selkies_web` 解压到临时目录。方案 B 依赖它 |
| 入口页缓存 | `stream_server.py:4052` | 入口页和名字固定的 JS 带 `Cache-Control: no-cache`，`assets/` 下带 hash 的文件正常缓存。注入的改动刷新即生效 |
| `subfolder`（环境变量 `SUBFOLDER`） | `settings.py:672` | 所有路由前加路径前缀，前端从自己的 URL 推导前缀。挂在子路径下时，扩展的 URL 也要用相对路径 |
| WebSocket 路由 | `stream_server.py:1123` | `/api/websockets`、`/api/webrtc/signaling`、`/api/ws` 三个，代理层必须全部支持 Upgrade |
| WebSocket Origin 校验 | `stream_server.py:2214` | `allowed_origins` 为空时，Origin 必须和 `Host` 头匹配。代理必须 `proxy_set_header Host $host`，否则返回 403 Forbidden origin |
| `frame_ancestors` | `settings.py:1156` | 默认 `'self'`，只允许同源页面用 iframe 嵌入。方案 C 要用到 |
| `addr` / `port` | `settings.py:94` | 默认只监听 loopback 的 8080。加代理时保持只听 loopback，只对外暴露代理 |
| Basic Auth | `settings.py:645` | 默认开启，由 selkies 自己校验 `Authorization` 头。代理会把这个头原样透传，浏览器弹窗还是 selkies 弹的 |

### 现有的 `command` 消息

core 支持 `postMessage({type: 'command', value: '<shell 命令>'})`，会把命令转成 `cmd,<命令>` 发给服务端，由 `input_handler.py:9547` 执行。它的限制如下：

- 服务端默认关闭，需要 `SELKIES_COMMAND_ENABLED=true` 或 `--command-enabled true`。
- 共享（只读）模式下，前端会直接拦掉。
- 只返回 `command_done` / `command_error`，拿不到 stdout。
- 任何连上来的客户端都能执行任意命令。

这个消息的定位是启动应用，不适合当配置接口用，理由见「系统配置后端」一节。

## 方案对比与选型

选定方案 A（反向代理注入）。它不碰 selkies 的任何文件，升级 selkies 时扩展不用跟着动，而且和 selkies 页面同源。如果环境里不方便加 nginx，就退到方案 B。

| 方案 | 做法 | 动 selkies 文件 | 升级成本 | 全屏时面板 | 主要风险 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| A. 反向代理注入 | nginx `sub_filter` 在 `</body>` 前插入 `<script>`；扩展静态文件和后端由同一个 nginx 提供 | 不动 | 无（只要 `</body>` 还在） | 可见 | 多一层代理，WebSocket 和 Host 头要配对 | **推荐** |
| B. `web_root` 覆盖 | 把 `selkies_web` 复制到独立目录，只在 `index.html` 里加一行 `<script>`，启动参数加 `--web_root` | 不动源码，只复制构建产物 | 每次升级都要重新复制和注入（脚本化） | 可见 | 忘记重新复制就是旧 core 配新服务端 | 备选 |
| C. 外层 iframe 包装 | 外层页面放 iframe 加载 selkies，右侧栏放在外层 | 不动 | 无 | **不可见**（只全屏 iframe） | 指针锁定、剪贴板、麦克风、游戏手柄权限都要 `allow`；焦点在两个文档间切换 | 不推荐 |
| D. 浏览器扩展 / Tampermonkey | 客户端注入和 A 相同的脚本 | 不动 | 无 | 可见 | 每个客户端都要单独安装；后端仍要同源或配 CORS | 仅限个人自用或开发调试 |

**为什么不选 C**：用户按 `Ctrl+Shift+F` 或点 dashboard 的全屏时，调用的是 iframe 文档里的 `requestFullscreen`，只有 iframe 会全屏，外层的右侧栏就看不到了。这一点在不改 selkies 的前提下绕不开。如果将来只是想把 selkies 嵌在另一个门户里，C 仍然可用，配置要点见「已知限制」一节。

**方案 B 的做法**（没有 nginx 时使用）：

```bash
#!/bin/sh
# sync-web-root.sh：在安装或升级 selkies 后执行
set -eu
SRC=$(python3 -c 'import importlib.resources as r; print(r.files("selkies.selkies_web"))')
DST=/opt/selkies-web
rm -rf "$DST" && cp -a "$SRC" "$DST"
grep -q 'ext/right-panel.js' "$DST/index.html" || \
  sed -i 's#</body>#<script src="ext/right-panel.js" defer></script></body>#' "$DST/index.html"
mkdir -p "$DST/ext" && cp -a /opt/selkies-ext/* "$DST/ext/"
# 启动：selkies --web_root /opt/selkies-web ...
```

方案 B 下，配置后端和 selkies 不同源（端口不同），需要在后端开 CORS，并把认证独立做一套。这也是 A 更省事的原因。

## 推荐方案总体架构

扩展由三部分组成：nginx 注入层、右侧面板脚本、配置后端。selkies 本身只是改了监听端口，其他保持原样。

&#91;embedded content: 推荐方案架构 · 浏览器、nginx、三个上游\]

浏览器发出的四类请求在 nginx 分流：只有入口页在返回途中被改写；画面、文件和 WebSocket 原样到 selkies；面板脚本和配置 API 由扩展自己提供。

| 组件 | 位置 | 负责 | 详见 |
| --- | --- | --- | --- |
| nginx 注入层 | `/etc/nginx/conf.d/selkies.conf` | TLS、路由分流、入口页注入 | 步骤一 |
| 右侧面板 | `/opt/selkies-ext/web/right-panel.js` | 拉手、侧边栏、表单渲染 | 步骤二 |
| 配置后端 | `/opt/selkies-ext/backend/`（`app.py`、`programs.yaml`） | 认证、白名单读写、执行固定命令、审计 | 步骤三 |

## 实现步骤一：部署 selkies 与 nginx 注入层

selkies 只监听 `127.0.0.1:8081`，对外只暴露 nginx。nginx 只对入口页做 `sub_filter` 注入，其他路径原样透传。

### 1.1 启动 selkies

```bash
# 只听 loopback；密码照常由 selkies 自己校验
export SELKIES_BASIC_AUTH_PASSWORD='<主密码>'
selkies --addr 127.0.0.1 --port 8081
```

- 不要加 `--public`，否则 selkies 会绕过代理对外监听。
- 不要设 `--web_root`，直接用包内打包的前端。
- 如果要把整个站点挂在子路径下（如 `/desk/`），给 selkies 加 `SUBFOLDER=/desk/`，并把下面配置里的 `/` 前缀换成 `/desk/`。

### 1.2 nginx 配置

```nginx
# /etc/nginx/conf.d/selkies.conf
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

upstream selkies    { server 127.0.0.1:8081; }
upstream selkies_ext { server 127.0.0.1:9000; }   # 自建配置后端

server {
    listen 443 ssl;
    http2 on;
    server_name desk.example.com;
    ssl_certificate     /etc/nginx/tls/fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/privkey.pem;

    client_max_body_size 0;          # selkies 的文件上传 /api/upload

    # 公共代理头，所有 location 继承
    proxy_http_version 1.1;
    proxy_set_header Host              $host;       # 必须：selkies 用它校验 WebSocket 的 Origin
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # 1) 入口页：只在这里注入
    location ~ ^/(index\.html)?$ {
        proxy_pass http://selkies;
        proxy_set_header Accept-Encoding "";   # 上游不压缩，sub_filter 才能匹配
        proxy_set_header If-None-Match "";     # 不要 304，每次拿完整页面再注入
        proxy_set_header If-Modified-Since "";
        sub_filter_once on;
        sub_filter_types text/html;
        sub_filter '</head>' '<script src="ext/right-panel.js" defer></script></head>';
        add_header Cache-Control "no-cache" always;
    }

    # 2) 扩展静态文件
    location /ext/ {
        alias /opt/selkies-ext/web/;
        add_header Cache-Control "no-cache" always;
    }

    # 3) 扩展后端 API
    location /ext-api/ {
        proxy_pass http://selkies_ext/;
        proxy_set_header Authorization $http_authorization;   # 后端自己校验，见安全设计
        proxy_read_timeout 60s;
    }

    # 4) 其他一切（静态资源、/api/*、三个 WebSocket）原样转给 selkies
    location / {
        proxy_pass http://selkies;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;               # 文件下载、录屏等流式响应
        proxy_request_buffering off;       # 大文件上传
        proxy_read_timeout 1d;             # WebSocket 长连接
        proxy_send_timeout 1d;
    }
}
```

### 1.3 配置要点

1. **注入点选 `</head>`。** 已发布的 selkies 2.1.0 wheel 里，压缩后的 `index.html` 仍保留 `</head>` 和 `</body>`。注入点放在 `</head>`、脚本加 `defer`，脚本不阻塞渲染，在 DOM 解析完后按文档顺序执行，也就是排在 dashboard 自己的 module 脚本之后。面板代码不要依赖 dashboard 已经渲染完：挂载到 document.body 即可，不要去找 dashboard 内部的节点。
2. **只对入口页注入。** `/api/files/` 的文件浏览页也是 HTML，全局开 `sub_filter` 会把面板也注入到那里。
3. **必须带 `Host $host`。** selkies 在 `allowed_origins` 为空时，要求 WebSocket 的 `Origin` 和 `Host` 头匹配（`_is_origin_allowed`），否则返回 403。
4. **WebSocket 路径不用单独写。** `/api/websockets`、`/api/webrtc/signaling`、`/api/ws` 都落在 `location /`，那里已带 Upgrade 头。
5. **WebRTC 媒体不走 nginx。** WebRTC 模式下，nginx 只转信令，媒体流走 UDP / TURN，和现在的部署一致，不用改。
6. **文件路径用相对写法。** 注入的 `ext/right-panel.js` 没有前导 `/`，挂在子路径下也能正确解析。脚本里请求后端也一样用相对路径，见步骤二。

### 1.4 用 Docker Compose 部署时

把 nginx 加成一个独立服务，和 selkies 容器共享网络命名空间（`network_mode: service:selkies`）。这样上面的 `127.0.0.1` 写法不用改，只把 nginx 的端口映射出去。配置后端如果要改容器里的系统程序，就跑在 selkies 容器内部（由容器里的进程管理器拉起）；如果要改宿主机，就跑在宿主机上。

## 实现步骤二：右侧面板前端脚本

面板是一个零依赖的单文件脚本，用 Shadow DOM 和 dashboard 的样式隔离。根元素带 `allow-native-input`，所以面板里的按键不会转发到远程桌面。表单内容由后端下发的描述（schema）渲染，以后新增可配置的程序只改后端，前端不用动。

### 2.1 文件布局

```
/opt/selkies-ext/
├── web/
│   └── right-panel.js        # nginx /ext/ 提供，注入到入口页
└── backend/
    ├── app.py                # 配置后端，监听 127.0.0.1:9000
    ├── programs.yaml         # 可配置程序的白名单
    └── audit.log
```

### 2.2 right-panel.js 完整示例

```js
/**
 * selkies 右侧扩展面板。由 nginx 注入到 selkies 入口页，零依赖。
 * 部署位置：/opt/selkies-ext/web/right-panel.js
 */
(() => {
  'use strict';
  if (window.__selkiesRightPanel) return;          // 防止重复注入
  window.__selkiesRightPanel = true;

  const API = new URL('ext-api/v1/', document.baseURI).href;   // 兼容 SUBFOLDER
  const PANEL_WIDTH = 360;
  const EDGE_PX = 48;                              // 鼠标离右边缘多近时显示拉手

  // ---------- 后端调用 ----------
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(API + path, {
      method,
      credentials: 'same-origin',                  // 带上浏览器缓存的 Basic Auth
      headers: { 'Content-Type': 'application/json', 'X-Selkies-Ext': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---------- DOM 骨架 ----------
  const host = document.createElement('div');
  host.id = 'selkies-right-panel';
  host.className = 'allow-native-input';           // 关键：面板内按键不转发到远程桌面
  host.style.cssText = 'position:fixed;top:0;right:0;width:0;height:100%;z-index:10000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { --bg:#1f1f23; --fg:#e8e8ea; --muted:#9a9aa2; --line:#33333a; --accent:#d9363e; }
      :host([data-theme="light"]) { --bg:#fff; --fg:#1d1d20; --muted:#6b6b73; --line:#e2e2e6; }
      * { box-sizing:border-box; }
      .handle { position:absolute; top:50%; right:0; width:15px; height:60px; transform:translateY(-50%);
                background:var(--accent); border-radius:6px 0 0 6px; cursor:pointer; opacity:0;
                transition:opacity .2s, right .2s; }
      .handle.near, .handle:hover, :host(.open) .handle { opacity:1; }
      @media (hover: none) { .handle { opacity:.6; width:24px; } }   /* 触屏没有悬停，常显 */
      :host(.open) .handle { right:min(${PANEL_WIDTH}px, 100vw); }
      .panel { position:absolute; top:0; right:0; width:min(${PANEL_WIDTH}px, 100vw); height:100%;
               display:flex; flex-direction:column; background:var(--bg); color:var(--fg);
               font:14px/1.5 system-ui, sans-serif; box-shadow:-4px 0 16px rgba(0,0,0,.35);
               transform:translateX(100%); transition:transform .2s; }
      :host(.open) .panel { transform:none; }
      header { display:flex; align-items:center; justify-content:space-between; padding:12px 16px;
               border-bottom:1px solid var(--line); font-weight:600; }
      .body { flex:1; overflow:auto; padding:8px 16px 24px; }
      .status { min-height:20px; padding:4px 16px; font-size:12px; color:var(--muted); }
      .status.err { color:var(--accent); }
      section { padding:12px 0; border-bottom:1px solid var(--line); }
      h3 { margin:0 0 8px; font-size:14px; }
      label { display:block; margin:8px 0 4px; color:var(--muted); font-size:12px; }
      input[type=text], input[type=number], select { width:100%; padding:6px 8px; color:var(--fg);
               background:transparent; border:1px solid var(--line); border-radius:6px; font:inherit; }
      .check { display:flex; align-items:center; gap:8px; margin:8px 0; color:var(--fg); font-size:14px; }
      .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
      button { padding:6px 12px; border:1px solid var(--line); border-radius:6px; background:transparent;
               color:var(--fg); font:inherit; cursor:pointer; }
      button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
      button:disabled { opacity:.5; cursor:wait; }
      .close { border:none; font-size:18px; padding:0 4px; }
    </style>
    <div class="handle" title="系统设置"></div>
    <aside class="panel" role="dialog" aria-label="系统设置" inert>
      <header><span>系统设置</span><button class="close" aria-label="关闭">×</button></header>
      <div class="status"></div>
      <div class="body"></div>
    </aside>`;
  const $ = (sel) => root.querySelector(sel);
  const handle = $('.handle'), panel = $('.panel'), body = $('.body'), status = $('.status');

  // ---------- 开关 ----------
  let loaded = false;
  function setOpen(open) {
    host.classList.toggle('open', open);
    panel.inert = !open;                            // 关闭时不可聚焦
    if (open) {
      if (!loaded) load();
    } else if (root.activeElement) {
      root.activeElement.blur();                    // 键盘交还给远程桌面
    }
  }
  handle.addEventListener('click', () => setOpen(!host.classList.contains('open')));
  $('.close').addEventListener('click', () => setOpen(false));
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  window.addEventListener('mousemove', (e) => {
    handle.classList.toggle('near', window.innerWidth - e.clientX < EDGE_PX);
  }, { passive: true });

  // 跟随经典 dashboard 的主题（它存在 localStorage 'theme'）
  function syncTheme() {
    let t = 'dark';
    try { t = localStorage.getItem('theme') || 'dark'; } catch { /* 存储被禁用 */ }
    host.dataset.theme = t;
  }
  syncTheme();
  window.addEventListener('storage', syncTheme);

  // ---------- 渲染 ----------
  function el(tag, attrs = {}, text) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;   // 一律 textContent，不拼 HTML
    return n;
  }
  function say(msg, isErr = false) {
    status.textContent = msg;
    status.classList.toggle('err', isErr);
  }
  function fieldInput(f, value) {
    if (f.type === 'bool') {
      const wrap = el('label', { class: 'check' });
      const box = el('input', { type: 'checkbox', name: f.key });
      box.checked = Boolean(value);
      wrap.append(box, document.createTextNode(f.label));
      return [wrap];
    }
    const label = el('label', {}, f.label);
    let input;
    if (f.type === 'select') {
      input = el('select', { name: f.key });
      for (const o of f.options) input.append(el('option', { value: o }, o));
    } else {
      input = el('input', { type: f.type === 'number' ? 'number' : 'text', name: f.key });
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
    }
    input.value = value ?? '';
    return [label, input];
  }
  function readForm(form, fields) {
    const out = {};
    for (const f of fields) {
      const input = form.elements.namedItem(f.key);
      out[f.key] = f.type === 'bool' ? input.checked
                 : f.type === 'number' ? Number(input.value) : input.value;
    }
    return out;
  }
  async function busy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { say(e.message, true); } finally { btn.disabled = false; }
  }
  function renderProgram(p) {
    const sec = el('section');
    const form = el('form');
    form.addEventListener('submit', (e) => e.preventDefault());
    for (const f of p.fields) form.append(...fieldInput(f, p.values[f.key]));
    const actions = el('div', { class: 'actions' });
    const save = el('button', { type: 'button', class: 'primary' }, '保存');
    save.addEventListener('click', () => busy(save, async () => {
      await api(`programs/${encodeURIComponent(p.id)}/config`,
                { method: 'PUT', body: readForm(form, p.fields) });
      say(`${p.title}：已保存`);
    }));
    actions.append(save);
    for (const a of p.actions || []) {
      const b = el('button', { type: 'button' }, a.label);
      b.addEventListener('click', () => busy(b, async () => {
        const r = await api(
          `programs/${encodeURIComponent(p.id)}/actions/${encodeURIComponent(a.id)}`,
          { method: 'POST' });
        say(`${p.title}：${r.message || '已执行'}`);
      }));
      actions.append(b);
    }
    sec.append(el('h3', {}, p.title), form, actions);
    return sec;
  }
  async function load() {
    say('加载中…');
    try {
      const { programs } = await api('programs');
      body.replaceChildren(...programs.map(renderProgram));
      loaded = true;
      say('');
    } catch (e) {
      say(`加载失败：${e.message}`, true);
    }
  }

  // defer 脚本执行时 body 已经存在
  document.body.appendChild(host);
})();
```

### 2.3 设计要点

| 问题 | 做法 | 原因 |
| --- | --- | --- |
| 键盘隔离 | shadow host 带 `allow-native-input` | core 在 `window` 捕获阶段拦按键，只放过带这个 class 的目标；shadow 内的事件到 `window` 时目标是 host |
| 鼠标不串到远程桌面 | 面板是独立的顶层元素，不在 core 的视频层内 | core 的指针、滚轮、触摸监听都绑在自己的视频层元素上，点在面板上的事件到不了那里 |
| 不挡视频 | host 宽度为 0，只有拉手和面板占位 | 关闭时只有 15px 的拉手会拦截点击 |
| 层级 | `z-index: 10000` | dashboard 最高是 `9999`，左侧拉手是 `1020` |
| 键盘交还 | 关闭时 `blur()` 当前焦点，并设 `inert` | 否则焦点还留在面板输入框里，打字不会到远程桌面 |
| 触屏 | `@media (hover: none)` 时拉手常显并加宽 | 触屏没有 `mousemove` 悬停提示 |
| XSS | 全部用 `textContent` 和 `setAttribute` 构造 | 后端返回的值可能含用户写进配置文件的内容 |
| 子路径 | `new URL('ext-api/v1/', document.baseURI)` | 页面挂在 `/desk/` 下时自动变成 `/desk/ext-api/v1/` |

不要在面板里绑定 `Ctrl+Shift+M/F/X/G`，这几个组合键会先被 selkies 的热键处理。Escape 可以正常用来关闭面板：core 的 `_escapeHatch`（`lib/input.js:2388`）只在游戏模式下、一秒内连按三次 Escape 时才拦截，而游戏模式下本来就点不到面板。

### 2.4 可选：和 core 交互

面板和 dashboard 同源，可以使用同一套协议。例如：

```js
// 读服务端资源占用（core 定时刷新这个全局变量）
setInterval(() => { const s = window.system_stats; if (s) renderStats(s); }, 2000);

// 监听 core 的广播，必须校验 origin
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  if (e.data?.type === 'pipelineStatusUpdate') { /* 视频/音频是否在传 */ }
});

// 让 core 做事，比如改完分辨率配置后让画面重新跟随窗口
window.postMessage({ type: 'resetResolutionToWindow' }, location.origin);
```

只用 README 里写明的消息类型。内部字段和全局变量在 selkies 升级时可能变化，用到的每一项都要记入「升级维护」一节的核对清单。

## 实现步骤三：系统配置后端

后端是一个只监听 `127.0.0.1:9000` 的小服务。它只提供白名单里声明过的操作：读写指定配置文件里的指定字段，执行预先写死的命令。不接受任何来自浏览器的命令或路径。

### 3.1 为什么不用 selkies 的 `command` 消息

| 对比项 | selkies `command` | 自建后端 |
| --- | --- | --- |
| 默认状态 | 关闭，要开 `SELKIES_COMMAND_ENABLED=true` | 独立部署 |
| 能执行什么 | 任意 shell 命令，开了就对所有 controller 客户端生效 | 只有白名单里的字段和命令 |
| 返回结果 | 只有 `command_done` / `command_error`，拿不到输出 | 返回 JSON，含当前值、错误信息、命令输出 |
| 读取当前配置 | 做不到 | `GET` 接口 |
| 运行身份 | selkies 桌面用户 | 可单独指定用户，配合 sudoers 精确提权 |
| 审计 | selkies 日志里一行 INFO | 独立审计日志，记录谁、何时、改了什么 |

### 3.2 API

浏览器访问的是 `/ext-api/v1/...`，nginx 去掉 `/ext-api` 前缀后转给后端。

| 方法 | 路径 | 请求体 | 返回 |
| --- | --- | --- | --- |
| `GET` | `/v1/programs` | 无 | `{programs: [{id, title, fields, values, actions}]}` |
| `PUT` | `/v1/programs/{id}/config` | `{字段名: 新值}`，只含要改的字段 | `{ok: true}`；配了 `on_save` 时返回该动作的结果 |
| `POST` | `/v1/programs/{id}/actions/{action}` | 无 | `{ok, message, output}` |

所有请求都必须带 `X-Selkies-Ext: 1` 和有效的 `Authorization`。出错统一返回 `{error: "..."}` 和对应的 HTTP 状态码。

### 3.3 白名单：programs.yaml

下面的 `my-agent` 只是示例，换成实际要管的程序。示例假定它的配置是 `KEY="VALUE"` 格式的 env 文件（如 `/etc/default/*`），由 systemd 管理。

```yaml
programs:
  - id: my-agent
    title: 上报代理
    file: /etc/default/my-agent        # 只改这个文件
    fields:
      - { key: LOG_LEVEL, label: 日志级别, type: select, options: [debug, info, warn, error], default: info }
      - { key: PORT, label: 监听端口, type: number, min: 1024, max: 65535, default: 7000 }
      - { key: ENABLE_UPLOAD, label: 允许上传, type: bool, default: false }
      - { key: SERVER_URL, label: 服务器地址, type: text, pattern: 'https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._/-]*)?' }
    on_save: restart                   # 保存后自动执行的动作（可选）
    actions:
      - { id: restart, label: 重启, argv: [sudo, -n, /usr/bin/systemctl, restart, my-agent.service], done: 已重启 }
      - { id: status, label: 查看状态, argv: [/usr/bin/systemctl, is-active, my-agent.service], done: 运行中 }
```

### 3.4 app.py 完整示例

依赖：`aiohttp`（selkies 自己也在用）和 `PyYAML`。

```python
"""selkies 右侧面板的配置后端。只监听 loopback，经 nginx 的 /ext-api/ 访问。"""
import asyncio
import base64
import hmac
import json
import logging
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

import yaml
from aiohttp import web

BASE = Path(__file__).resolve().parent
PROGRAMS = {p["id"]: p for p in yaml.safe_load((BASE / "programs.yaml").read_text())["programs"]}
AUTH_USER = os.environ["EXT_AUTH_USER"]
AUTH_PASSWORD = os.environ["EXT_AUTH_PASSWORD"]   # 与 selkies 主密码相同，绝不是只读密码
ACTION_TIMEOUT = 30
SAFE_TEXT = re.compile(r"[^\"\\\n\r$`]{0,256}")     # env 文件里不能出现的字符
ENV_LINE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
WRITE_LOCK = asyncio.Lock()
audit = logging.getLogger("audit")


def fail(status, msg):
    return web.json_response({"error": msg}, status=status)


# ---------- 认证与 CSRF ----------
@web.middleware
async def guard(request, handler):
    if request.headers.get("X-Selkies-Ext") != "1":
        return fail(403, "missing X-Selkies-Ext")
    origin = request.headers.get("Origin")
    if origin and urlsplit(origin).hostname != request.host.split(":")[0]:
        return fail(403, "cross-origin request")
    ok = False
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Basic "):
        try:
            user, _, pw = base64.b64decode(auth[6:]).decode("utf-8").partition(":")
            ok = hmac.compare_digest(user.encode(), AUTH_USER.encode()) & \
                 hmac.compare_digest(pw.encode(), AUTH_PASSWORD.encode())
        except ValueError:
            ok = False
    if not ok:
        return fail(401, "unauthorized")      # 不发 WWW-Authenticate，避免浏览器再弹一次登录框
    request["user"] = user
    return await handler(request)


# ---------- env 文件读写 ----------
def read_env(path):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            m = ENV_LINE.match(line)
            if m:
                values[m.group(1)] = m.group(2).strip().strip('"')
    return values


def write_env(path, updates):
    """只改白名单字段，保留其他行和注释；先备份，再原子替换。"""
    lines = path.read_text().splitlines() if path.exists() else []
    seen = set()
    for i, line in enumerate(lines):
        m = ENV_LINE.match(line)
        if m and m.group(1) in updates:
            lines[i] = f'{m.group(1)}="{updates[m.group(1)]}"'
            seen.add(m.group(1))
    lines += [f'{k}="{v}"' for k, v in updates.items() if k not in seen]
    if path.exists():
        shutil.copy2(path, path.with_name(f"{path.name}.bak.{int(time.time())}"))
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    if path.exists():
        shutil.copymode(path, tmp)
    os.replace(tmp, path)


# ---------- 校验与类型转换 ----------
def to_file_value(field, raw):
    """把浏览器传来的值转成写入文件的字符串，不合法就抛 ValueError。"""
    kind = field["type"]
    if kind == "bool":
        if not isinstance(raw, bool):
            raise ValueError
        return "true" if raw else "false"
    if kind == "number":
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ValueError
        if not field.get("min", raw) <= raw <= field.get("max", raw):
            raise ValueError
        return str(int(raw)) if float(raw).is_integer() else str(raw)
    if not isinstance(raw, str) or not SAFE_TEXT.fullmatch(raw):
        raise ValueError
    if kind == "select" and raw not in field["options"]:
        raise ValueError
    if kind == "text" and "pattern" in field and not re.fullmatch(field["pattern"], raw):
        raise ValueError
    return raw


def to_view_value(field, text):
    if text is None:
        return None
    if field["type"] == "bool":
        return str(text).lower() == "true"
    if field["type"] == "number":
        try:
            return float(text) if "." in str(text) else int(text)
        except ValueError:
            return None
    return str(text)


def view(p):
    raw = read_env(Path(p["file"]))
    return {
        "id": p["id"],
        "title": p["title"],
        "fields": p["fields"],
        "values": {f["key"]: to_view_value(f, raw.get(f["key"], f.get("default"))) for f in p["fields"]},
        "actions": [{"id": a["id"], "label": a["label"]} for a in p.get("actions", [])],
    }


# ---------- 动作 ----------
async def run_action(request, p, action_id):
    action = next((a for a in p.get("actions", []) if a["id"] == action_id), None)
    if action is None:
        return fail(404, "unknown action")
    proc = await asyncio.create_subprocess_exec(       # argv 列表，不经过 shell
        *action["argv"], stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), ACTION_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return fail(504, f"{action['label']} 超时")
    text = out.decode("utf-8", "replace")[-4000:]
    audit.info(json.dumps({"user": request["user"], "ip": request.headers.get("X-Forwarded-For"),
                           "program": p["id"], "action": action_id, "exit": proc.returncode},
                          ensure_ascii=False))
    if proc.returncode != 0:
        return fail(500, f"{action['label']}失败（exit {proc.returncode}）：{text.strip()[-200:]}")
    return web.json_response({"ok": True, "message": action.get("done", "已执行"), "output": text})


# ---------- 路由 ----------
async def list_programs(request):
    return web.json_response({"programs": [view(p) for p in PROGRAMS.values()]})


async def put_config(request):
    p = PROGRAMS.get(request.match_info["pid"])
    if p is None:
        return fail(404, "unknown program")
    try:
        body = await request.json()
    except ValueError:
        return fail(400, "invalid JSON")
    fields = {f["key"]: f for f in p["fields"]}
    if not isinstance(body, dict) or not body:
        return fail(400, "empty update")
    updates = {}
    for key, raw in body.items():
        if key not in fields:
            return fail(400, f"unknown field {key}")
        try:
            updates[key] = to_file_value(fields[key], raw)
        except (ValueError, TypeError):
            return fail(400, f"{fields[key]['label']} 的值不合法")
    async with WRITE_LOCK:
        await asyncio.to_thread(write_env, Path(p["file"]), updates)
    audit.info(json.dumps({"user": request["user"], "ip": request.headers.get("X-Forwarded-For"),
                           "program": p["id"], "set": updates}, ensure_ascii=False))
    if p.get("on_save"):
        return await run_action(request, p, p["on_save"])
    return web.json_response({"ok": True})


async def post_action(request):
    p = PROGRAMS.get(request.match_info["pid"])
    if p is None:
        return fail(404, "unknown program")
    return await run_action(request, p, request.match_info["aid"])


def main():
    logging.basicConfig(level=logging.INFO)
    audit.addHandler(logging.FileHandler(BASE / "audit.log"))
    app = web.Application(middlewares=[guard], client_max_size=64 * 1024)
    app.add_routes([
        web.get("/v1/programs", list_programs),
        web.put("/v1/programs/{pid}/config", put_config),
        web.post("/v1/programs/{pid}/actions/{aid}", post_action),
    ])
    web.run_app(app, host="127.0.0.1", port=9000)


if __name__ == "__main__":
    main()
```

### 3.5 扩展到其他配置格式

示例只实现了 env 格式。要支持 INI、JSON、TOML 或 `gsettings` / `dconf` 这类命令式配置，就在 `programs.yaml` 里加一个 `format` 字段，把 `read_env` / `write_env` 抽成按格式选择的读写器。规则不变：只写白名单字段；命令式配置用 argv 列表拼定参数，绝不拼 shell 字符串。

### 3.6 用 systemd 运行

```ini
# /etc/systemd/system/selkies-ext.service
[Unit]
Description=selkies right-panel config backend
After=network.target

[Service]
User=selkies-ext
Group=selkies-ext
EnvironmentFile=/etc/selkies-ext/auth.env      # EXT_AUTH_USER / EXT_AUTH_PASSWORD，权限 0600
ExecStart=/usr/bin/python3 /opt/selkies-ext/backend/app.py
NoNewPrivileges=false                          # 需要 sudo 重启服务时保持 false
ProtectHome=true
PrivateTmp=true
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

容器里没有 systemd 时，就用 selkies 镜像自带的进程管理方式（比如 supervisord 或 s6）拉起同一条命令。

## 安全设计

这个面板能改系统配置、重启服务，权限比 selkies 本身的大多数功能都高。原则是：只有持主密码的人能用；只能做白名单里的事；每一步都留痕。

### 认证：必须由后端自己校验主密码

- selkies 支持主密码和只读密码（`basic_auth_viewonly_password`）两种登录。只读密码登录的人是 viewer 角色，但他们同样能拿到入口页。
- 因此**不能**用 nginx 的 `auth_request` 去问 selkies 的 `/`：只读用户也能通过。后端必须拿主密码自己做常量时间比较，示例中的 `guard` 就是这样做的。
- 浏览器在 `/` 上完成 Basic Auth 后，会自动对同一站点下的其他路径（包括 `/ext-api/`）带上同一个 `Authorization` 头，所以面板不用再登录一次。
- 后端的 401 响应不要带 `WWW-Authenticate`，否则只读用户点面板时会弹出浏览器登录框。
- 用共享模式或只读链接访问的用户，面板会显示「加载失败：unauthorized」。如果希望他们完全看不到拉手，可以在前端先请求一次 `programs`，401 时就不挂载。
- 如果部署用的是 selkies 的 `master_token` / 会话 token，而不是 Basic Auth，浏览器就不会带 `Authorization`。这时要给扩展单独设计认证（比如 nginx `auth_basic` 加一个独立密码），本文示例不覆盖这种情况。

### CSRF 与跨站

- 所有请求必须带自定义头 `X-Selkies-Ext: 1`。跨站表单和 `<img>` 发不出自定义头；跨站 `fetch` 带自定义头会触发预检，而后端不回 CORS 头，请求会被浏览器拦下。
- 后端另外校验 `Origin` 的主机名是否等于 `Host`，和 selkies 自己校验 WebSocket 的规则一致。
- 不要给后端加 `Access-Control-Allow-Origin`。

### 白名单与输入校验

- 浏览器只能传**程序 id、字段名、字段值、动作 id**。文件路径和命令只存在于服务端的 `programs.yaml` 里，也不会下发给前端。
- 未知字段直接 400；数值校验范围；下拉框校验取值在 `options` 内；文本先用 `SAFE_TEXT` 排除引号、反斜杠、换行、`$` 和反引号，再匹配字段自己的 `pattern`。
- 命令一律用 `create_subprocess_exec` 传 argv 列表，不经过 shell，并有 30 秒超时。字段值不得拼进 argv。确实需要传参数时，按同样的规则校验后，只放在固定位置。
- `programs.yaml` 和 `app.py` 的属主设为 root，权限 0644，后端运行用户不能改它们。

### 最小权限：运行用户与文件权限

先分清要管的是哪一类程序：

| 要管的程序 | 后端运行用户 | 配置文件怎么写 | 动作怎么做 |
| --- | --- | --- | --- |
| 桌面用户自己的程序（`~/.config/...`、桌面应用） | selkies 桌面用户本人 | 直接写。单元文件里去掉 `ProtectHome=true` | `systemctl --user ...` 或发信号，不需要 sudo |
| 系统服务，配置可以放在专用目录 | 独立用户 `selkies-ext` | 把配置放在专用目录（如 `/etc/my-agent/`），目录和文件属组 `selkies-ext`、组可写 | sudoers 精确放行 |
| 系统服务，配置在公共目录（如 `/etc/default/`） | 独立用户 `selkies-ext` | 写到自己可写的暂存文件，再通过 sudoers 放行的 `install` 拷过去 | sudoers 精确放行 |

示例 `write_env` 的原子替换（`mkstemp` + `os.replace`）需要对**配置文件所在目录**有写权限。不要为了让它能跑就把 `/etc/default` 之类的公共目录放开，应该按上表第二行或第三行的办法处理。

sudoers 示例（用 `visudo -f` 编辑）：

```
# /etc/sudoers.d/selkies-ext —— 只允许白名单里用到的完整命令，参数写死
selkies-ext ALL=(root) NOPASSWD: /usr/bin/systemctl restart my-agent.service
selkies-ext ALL=(root) NOPASSWD: /usr/bin/install -m 0644 -o root -g root /var/lib/selkies-ext/staging/my-agent /etc/default/my-agent
```

不要写成 `systemctl *` 或 `/usr/bin/install *` 这样的通配符，那等于给了 root。

### 审计与可恢复

- 每次保存和每个动作各写一行 JSON 到 `audit.log`：用户、来源 IP（`X-Forwarded-For`）、程序、改动内容或动作、退出码。
- 审计日志里不要记密码类字段的值。给这类字段加 `secret: true`，记录时替换成 `***`；`GET` 接口也不返回它们的当前值。
- 每次写文件前保留 `.bak.<时间戳>` 备份。要设保留上限或定期清理，否则备份会一直堆积。
- 后端只听 `127.0.0.1`；主机防火墙不对外开放 8081 和 9000。

## 测试与验证清单

上线前和每次升级 selkies 后，都要把下面的清单跑一遍。其中「键盘隔离」和「只读用户被拒」两项必须用自动化测试覆盖。注意：本方案目前只经过源码分析，还没有在真实部署上跑过。

### 部署与注入

- [ ] `curl -su user:pass https://desk.example.com/ | grep right-panel.js` 有输出
- [ ] `curl -su user:pass https://desk.example.com/api/files/ | grep right-panel.js` 无输出（文件浏览页没有被注入）
- [ ] 直接访问 `http://<主机>:8081` 和 `:9000` 从外网连不上
- [ ] WebSocket 模式和 WebRTC 模式都能正常出画面；nginx 日志里没有 403 Forbidden origin
- [ ] 文件上传（大于 1 GB）和下载正常。验证 `client_max_body_size 0` 和 `proxy_request_buffering off` 生效

### 面板交互

- [ ] 鼠标移到右边缘 48px 内时拉手出现，移开后消失
- [ ] 点拉手打开面板，再点一次、点 × 或按 Escape 都能关闭
- [ ] 左侧 selkies 侧边栏和右侧面板同时打开，互不遮挡、都能操作
- [ ] 切换 dashboard 的亮 / 暗主题，面板刷新后跟随
- [ ] 浏览器全屏（`Ctrl+Shift+F` 和 dashboard 的全屏按钮）后面板仍然可见、可用
- [ ] 触屏设备（iPad / Android 平板）：拉手常显，点击能打开；面板宽度不超过屏幕
- [ ] 打开面板时，在视频区域点击和滚轮仍然正常传到远程桌面

### 键盘隔离（重点）

- [ ] 在面板文本框输入英文、数字、退格、方向键，远程桌面里当前聚焦的程序（先打开一个编辑器）**没有**收到任何字符
- [ ] 用中文输入法在面板里输入，候选框正常，远程桌面没有收到字符
- [ ] 在面板里按 `Ctrl+C` / `Ctrl+V` / `Ctrl+A`，作用于面板输入框而不是远程桌面
- [ ] 关闭面板后点一下视频区域再打字，字符正常进入远程桌面
- [ ] 在面板里按住 Shift 不放并关闭面板，远程桌面没有卡住的修饰键

### 后端与安全

- [ ] 主密码登录：能读取、保存、执行动作；`audit.log` 有对应记录
- [ ] 只读密码登录：`GET /ext-api/v1/programs` 返回 401，且不弹登录框
- [ ] 不带 `X-Selkies-Ext` 头的请求返回 403
- [ ] `Origin: https://evil.example` 的请求返回 403
- [ ] 提交未知字段、越界数字、不在 `options` 里的下拉值、带 `"`、`$(id)`、换行的文本，都返回 400，配置文件没有变化
- [ ] 保存后配置文件里其他行和注释保持不变，有 `.bak.*` 备份，文件权限不变
- [ ] 动作超时（临时把 argv 换成 `sleep 60`）时返回 504，进程被杀掉

### 自动化测试示例（Playwright）

```js
// tests/right-panel.spec.js
import { test, expect } from '@playwright/test';

const BASE = process.env.DESK_URL;                 // https://desk.example.com/
const creds = (password) => ({ username: process.env.DESK_USER, password });

test('面板输入不转发到远程桌面', async ({ browser }) => {
  const ctx = await browser.newContext({ httpCredentials: creds(process.env.DESK_PASSWORD) });
  const page = await ctx.newPage();
  const sent = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    if (typeof f.payload === 'string' && /^k[du],/.test(f.payload)) sent.push(f.payload);
  }));
  await page.goto(BASE);
  const host = page.locator('#selkies-right-panel');
  await page.mouse.move(page.viewportSize().width - 5, 300);
  await host.locator('.handle').click();                       // Playwright 的 locator 会穿透 open shadow root
  const input = host.locator('input[type=text]').first();
  await input.click();
  sent.length = 0;
  await input.pressSequentially('hello');
  await expect(input).toHaveValue(/hello$/);
  expect(sent).toEqual([]);                                    // 没有任何 kd,/ku, 按键帧发出
});

test('只读用户无法调用后端', async ({ playwright }) => {
  const api = await playwright.request.newContext({ httpCredentials: creds(process.env.DESK_VIEWONLY_PASSWORD) });
  const res = await api.get(new URL('ext-api/v1/programs', BASE).href, { headers: { 'X-Selkies-Ext': '1' } });
  expect(res.status()).toBe(401);
});
```

第一个用例假定使用 WebSocket 模式，按键以 `kd,<keysym>` / `ku,<keysym>` 文本帧发送。WebRTC 模式下按键走 DataChannel，这个断言抓不到，只能改成检查远程桌面里编辑器的内容。写断言前先用浏览器开发者工具确认实际的帧格式。

## 已知限制、问题排查与升级维护

扩展不改 selkies 的代码，但依赖 selkies 的 8 个外部行为。升级 selkies 时只要逐项核对这 8 项，就能判断扩展还能不能用。

### 已知限制

- **指针锁定与游戏模式**：鼠标被锁在画面里，点不到面板。要先按 Esc 解除指针锁定；游戏模式下要连按三次 Esc 或用 `Ctrl+Shift+X` 退出。
- **不同的 dashboard**：示例跟随的是经典 dashboard 的主题（`localStorage.theme`）。如果换成 wish dashboard，它的主题键是 `vite-ui-theme`，可能取值 `system`，`syncTheme` 要相应扩展。
- **没有 Basic Auth 的部署**：用 `master_token` 或关掉 Basic Auth 时，浏览器不会带 `Authorization`，后端的认证要另行设计（见「安全设计」）。
- **移动端空间**：手机上面板会占满整个屏幕宽度，右侧拉手也可能和浏览器的返回手势冲突。
- **iframe 嵌入（方案 C）**：如果确实要把 selkies 嵌到别的门户里，就设 `frame_ancestors`（门户跨域时还要设 `allowed_origins`），并给 iframe 加上 `allow="fullscreen; clipboard-read; clipboard-write; autoplay; microphone; camera; gamepad"`。即便这样，全屏后外层侧边栏仍然不可见。

### 常见问题排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 页面里没有右侧拉手 | 上游响应被压缩，`sub_filter` 没匹配上；或者拿到的是 304 | 检查 `Accept-Encoding ""` 和 `If-None-Match ""`；用 `curl` 看入口页里有没有 `right-panel.js` |
| 拉手有了，脚本 404 | `/ext/` 的 `alias` 末尾少了 `/`，或者挂在子路径下但 location 没加前缀 | 核对 nginx location 和文件权限 |
| 画面一直连不上，selkies 日志有 Rejected WebSocket upgrade from disallowed Origin | 代理没传 `Host`，或者改写成了上游地址 | `proxy_set_header Host $host` |
| 画面连上几分钟后断开 | `proxy_read_timeout` 太短 | 在 `location /` 里设成 `1d` |
| 面板里打字，字符也出现在远程桌面 | host 上的 `allow-native-input` 丢了，或者 selkies 改了白名单机制 | 检查 class；在 core 源码里搜 `WHITELIST_CLASS` |
| 关闭面板后在远程桌面打不了字 | 焦点还在面板里 | 确认 `setOpen(false)` 执行了 `blur()`；在视频区域点一下就能恢复 |
| 面板显示「加载失败：unauthorized」 | 用的是只读密码，或者 `EXT_AUTH_PASSWORD` 和 selkies 主密码不一致 | 核对 `/etc/selkies-ext/auth.env` |
| 保存时返回 500 PermissionError | 后端用户对配置文件所在目录没有写权限 | 按「最小权限」一节调整，不要放开公共目录 |
| 重启动作返回 `sudo: a password is required` | sudoers 规则和 argv 不完全一致 | sudoers 里的命令必须和 `argv` 逐字相同，包括绝对路径 |

### 升级 selkies 时的核对清单

拉取新版本源码（或解开新的 wheel），逐项确认：

| # | 依赖的行为 | 怎么确认 | 变了怎么办 |
| --- | --- | --- | --- |
| 1 | 键盘白名单 class 是 `allow-native-input` | `grep -n WHITELIST_CLASS addons/selkies-web-core/lib/input.js` | 改成新的 class 名 |
| 2 | `_targetHasClass` 沿 `parentElement` 往上找 | 看 `_targetHasClass` 的实现 | 如果改成只看目标本身，就把 class 加到每个输入控件上；如果改成用 `composedPath`，就加到 shadow 内元素上 |
| 3 | 打包后的 `index.html` 含 `</head>` | `unzip -p selkies-*.whl selkies/selkies_web/index.html` | 换一个注入锚点（如 `<div id="root">`） |
| 4 | WebSocket 路由仍是那三个，且都在 `/api/` 下 | `grep -n WEBSOCKET_ROUTES src/selkies/stream_server.py` | 按需调整 nginx |
| 5 | Origin 校验仍然拿 `Host` 头比较 | 看 `_is_origin_allowed` | 按需设 `allowed_origins` |
| 6 | dashboard 最高 `z-index` 低于 10000 | `grep -rn 'z-index' addons/selkies-dashboard/src/styles` | 抬高面板层级 |
| 7 | 经典 dashboard 的主题仍存在 `localStorage.theme` | `grep -n 'localStorage.setItem("theme"' addons/selkies-dashboard/src/components/Sidebar.jsx` | 改 `syncTheme` |
| 8 | 用到的 `postMessage` 类型和 `window.*` 变量仍然存在 | 对照 `addons/selkies-dashboard/README.md` | 更新面板代码 |

核对完，再跑一遍「测试与验证清单」。建议在 CI 里加一个任务：selkies 发布新版本时，自动跑第 1、3、4 项的 grep 和 Playwright 用例。

## 附录：源码关键位置索引

下表所有链接都固定在提交 `e7746b0`，升级后行号可能会变，按名字搜索即可。

| 位置 | 内容 | 和扩展的关系 |
| --- | --- | --- |
| [lib/input.js:82](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/addons/selkies-web-core/lib/input.js#L82) | `WHITELIST_CLASS = 'allow-native-input'` | 键盘隔离的依据 |
| [lib/input.js:2176](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/addons/selkies-web-core/lib/input.js#L2176) | `_handleKeyDown`：热键先于白名单处理，2194 行是白名单判断 | 面板不能用 `Ctrl+Shift+M/F/X/G` |
| [lib/input.js:2388](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/addons/selkies-web-core/lib/input.js#L2388) | `_escapeHatch`：游戏模式下连按三次 Esc 退出 | Esc 关面板不受影响 |
| [lib/input.js:2403](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/addons/selkies-web-core/lib/input.js#L2403) | `_handleKeyUp`：白名单目标会释放遗留按键 | 焦点移入面板时不会卡键 |
| [lib/input.js:5301](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/addons/selkies-web-core/lib/input.js#L5301) | `_targetHasClass`：沿 `parentElement` 向上查找 | class 加在根元素即可 |
| [lib/input.js:5392](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/addons/selkies-web-core/lib/input.js#L5392) | 在 `window` 捕获阶段注册 `keydown` / `keyup`，指针事件绑在视频层 | 鼠标不会从面板串到远程桌面 |
| [selkies-core.js:134](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/addons/selkies-web-core/selkies-core.js#L134) | `postMessage` 的同源校验 | 面板必须和 selkies 同源 |
| [selkies-ws-core.js:5824](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/addons/selkies-web-core/selkies-ws-core.js#L5824) | `command` 消息处理（共享模式拦截、`command_enabled` 开关） | 不采用的方案 |
| [selkies-ws-core.js:4911](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/addons/selkies-web-core/selkies-ws-core.js#L4911) | `websocketSendInput`：按键以文本帧发送 | Playwright 断言的依据 |
| [Sidebar.jsx:2991](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/addons/selkies-dashboard/src/components/Sidebar.jsx#L2991) | 左侧拉手 `toggle-handle` | 右侧拉手的参考 |
| [Overlay.css:994](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/addons/selkies-dashboard/src/styles/Overlay.css#L994) | 拉手尺寸和 `z-index: 1020` | 层级参考 |
| [selkies-dashboard/README.md](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/addons/selkies-dashboard/README.md) | core 与 dashboard 的消息协议 | 面板和 core 交互时只用这里写明的消息 |
| [stream\_server.py:1123](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/src/selkies/stream_server.py#L1123) | `WEBSOCKET_ROUTES` | nginx 要支持 Upgrade 的路径 |
| [stream\_server.py:2214](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/src/selkies/stream_server.py#L2214) | `_is_origin_allowed` | 代理必须传 `Host` |
| [stream\_server.py:2254](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/src/selkies/stream_server.py#L2254) | `_auth_middleware`：主密码和只读密码都能访问静态页 | 后端必须自己校验主密码 |
| [stream\_server.py:3480](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/src/selkies/stream_server.py#L3480) | `_get_static_content_path`：`web_root` 的处理 | 方案 B 的依据 |
| [stream\_server.py:3978](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/src/selkies/stream_server.py#L3978) | `initialize_app`：路由表、静态文件、入口页 `no-cache`（4052 行） | 只对入口页注入、刷新即生效 |
| [input\_handler.py:9547](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/src/selkies/input_handler.py#L9547) | 服务端执行 `cmd` 消息 | 不采用的方案 |
| [settings.py:94](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/src/selkies/settings.py#L94) | `addr`（默认只听 loopback） | selkies 不直接对外 |
| [settings.py:122](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/src/selkies/settings.py#L122) | `web_root` | 方案 B |
| [settings.py:188](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/src/selkies/settings.py#L188) | `command_enabled` | 保持默认关闭 |
| [settings.py:645](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/src/selkies/settings.py#L645) | `enable_basic_auth` 及主密码 / 只读密码（665 行） | 认证设计 |
| [settings.py:672](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/src/selkies/settings.py#L672) | `subfolder` | 子路径部署 |
| [settings.py:1150](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/src/selkies/settings.py#L1150) | `allowed_origins`、`frame_ancestors`（1156 行） | 跨域与 iframe |
| [scripts/ci/build-web.sh](https://github.com/selkies-project/selkies/blob/e7746b02ddb4516123fd40b73a2f9be1f7b8038e/scripts/ci/build-web.sh) | 前端怎么打进 wheel | 升级核对第 3 项 |
