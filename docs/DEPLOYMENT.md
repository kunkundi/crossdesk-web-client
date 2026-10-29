# 部署与开发指南

[返回项目首页](../README.md) · [English](DEPLOYMENT_EN.md)

[本地运行](#local) · [部署](#deployment) · [自建服务](#configuration) · [开发与验证](#development)

<a id="local"></a>

## 本地运行

安装 Git 和 Python 3 后执行：

```bash
git clone https://github.com/kunkundi/crossdesk-web-client.git
cd crossdesk-web-client
python3 -m http.server 8080 --bind 127.0.0.1
```

打开 [本地页面](http://127.0.0.1:8080/)，按 Ctrl+C 停止服务。此命令只供本机开发预览，网页仍使用 [web_client.js](../web_client.js) 中的默认公共信令与 STUN 配置。自建服务请先按下文覆盖配置；公开部署使用 HTTPS 静态托管。

<a id="deployment"></a>

## 部署

### GitHub Pages

1. Fork 本仓库。默认使用 GitHub 提供的域名时，删除 Fork 中指向 `web.crossdesk.cn` 的 [CNAME](../CNAME)，并检查 **Settings → Pages → Custom domain** 留空。使用自己的域名时，在 Pages 中配置域名及对应 DNS。
2. 若接入自建服务器，先完成下文的网页配置，并提交到准备发布的分支。
3. 打开 **Settings → Pages**，在 **Build and deployment → Source** 选择 **Deploy from a branch**，选择 `main`（或实际发布分支）和 **`/(root)`**，点击 **Save**。
4. 等待部署成功，使用 Pages 页面显示的站点地址；在设置中确认 **Enforce HTTPS** 已启用。部署失败时查看仓库的 Actions 运行记录。

具体发布入口见 [GitHub Pages 发布源说明](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)，证书和 HTTPS 设置见 [GitHub HTTPS 说明](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)。

### 查看和更新 Web 版本

连接表单底部和连接后的展开控制面板显示 Web 版本，例如 **version 2026.09.24.1**（格式示例，并非最新版本）。采用 `年.月.日.当天发布序号`，同一天再次发布时递增最后一位。版本标签由当前加载的 `web_client.js` 填写，不依赖信令连接是否成功。

每次发布前，在仓库根目录执行（需要 Node.js），将示例版本替换为本次实际发布版本：

```bash
node scripts/set-version.js 2026.09.24.2
```

该命令同步更新 `web_client.js` 中的版本号和 `index.html` 中 CSS / JS 的 `?v=` 缓存参数。将生成的改动与本次代码一起提交并部署，完成后刷新线上页面，确认显示的版本号与本次发布一致。手动部署时也需同步上传这些文件；修改下方自定义配置示例时，应保留当前资源标签上的 `?v=` 参数。

### 其他静态托管

将以下资源按原有相对路径上传到 HTTPS 站点目录，入口为 `index.html`：

```text
index.html
styles.css
web_client.js
control.js
turn_credentials.js
file_download.js
file_download_sw.js
file_transfer.js
clipboard.js
session_controls.js
vendor/adapter-9.0.1.min.js
icons/
favicon.ico
manifest.json
```

该站点只提供静态资源，WSS 信令和 STUN / TURN 由 CrossDesk Server 与 Coturn 提供。如果为 WSS 设置反向代理，需要支持 WebSocket 升级，并与 `signalingUrl` 的实际路径对应。

**自定义域名或子路径：** [index.html](../index.html) 的 canonical、社交分享和结构化数据，以及 [robots.txt](../robots.txt) / [sitemap.xml](../sitemap.xml) 都包含官方站点地址，发布自己的站点时应同步调整。[manifest.json](../manifest.json) 当前 `start_url` 为 `/`；部署到 `/crossdesk-web-client/` 等子路径时，改为 `./` 或实际站点路径，以免从主屏幕启动时进入域名根目录。文件接收使用同目录下的 Service Worker，只处理流式下载，不缓存站点资源；添加到主屏幕不代表支持离线远控。

<a id="configuration"></a>

## 自建服务器配置

### 1. 配置 WSS 和 STUN

先按 [CrossDesk Server 部署说明](https://github.com/kunkundi/crossdesk-server#运行服务) 启动信令服务和 Coturn，并设置被控桌面端使用该服务。

默认地址在 [web_client.js](../web_client.js) 的 `DEFAULT_CONFIG` 中。需要覆盖时，将以下代码插入 [index.html](../index.html) 底部、**现有 `control.js` 脚本标签之前**。保留所有现有脚本及 `?v=` 参数；应用脚本的加载顺序应为 `control.js` → `turn_credentials.js` → `file_download.js` → `file_transfer.js` → `clipboard.js` → `web_client.js` → `session_controls.js`。

```html
<script>
  window.CROSSDESK_CONFIG = {
    signalingUrl: "wss://203.0.113.10:9099",
    iceServers: [
      { urls: ["stun:203.0.113.10:3478"] },
    ],
  };
</script>
```

`203.0.113.10` 是示例地址，必须替换为自己的公网 IP 或域名。保留 **`wss://`** 和 **`stun:`** 前缀；示例端口对应当前服务端 Compose 默认值，修改过端口时需同步替换。

配置通过浅合并覆盖：未指定的字段沿用默认值，`iceServers` 数组会整体替换。当前没有 `.env` 自动加载、URL 参数配置或页面内的服务器设置入口；修改脚本后需要重新发布并刷新网页。

### 2. 配置证书信任与网络

- 网页 HTTPS 与信令 WSS 都需要浏览器认可的证书。站点证书正常，不代表另一个域名 / 端口上的 WSS 证书也正常。
- 使用自签证书时，在访问网页的设备上导入并信任服务端根证书，确保证书覆盖 `signalingUrl` 中的域名或 IP。按 [服务端证书指引](https://github.com/kunkundi/crossdesk-server#clients) 操作；网页没有导入证书或关闭证书校验的开关。
- 可先在同一浏览器访问 `https://你的信令主机:9099/stats`，确认没有证书错误并能返回 JSON，再连接远程设备。该接口只能验证 HTTPS 可达，仍需实际连接验证 WebSocket 和媒体链路。
- 按服务端配置开放 WSS TCP 端口、STUN / TURN TCP 与 UDP 端口，以及 Coturn 的 UDP 中继端口范围。仅能打开网页并不说明远控网络已打通。

### 3. 动态 TURN 凭据

新版服务端在 Offer 的 `ice` 字段中下发版本 1 的完整会话配置。网页校验其有效期后使用其中全部 STUN / TURN 节点，**以该列表替代本地 `iceServers` 和旧 TURN 凭据**；空列表表示仅尝试本地候选，格式错误或即将过期的列表会提示重试。备用 STUN 节点应配置在服务端，使 Web 与桌面端使用同一套节点。

以下配置用于没有下发 `ice` 字段的旧服务端：

`iceServers` 通常只配置 STUN。信令服务在登录和会话协商消息中下发临时 TURN 凭据，浏览器通过 [turn_credentials.js](../turn_credentials.js) 校验后保存在内存，并在创建 WebRTC 连接时加入 UDP / TCP TURN 地址。

- 凭据包含 `host`、`port`、`username`、`password` 和 `expires_at`（Unix 秒）。过期凭据不会继续用于新连接。
- 更新内存中的凭据和连接配置不会直接中断已建立的连接；后续中继使用仍受凭据有效期及服务端状态影响。
- `COTURN_AUTH_SECRET` 仅配置在信令服务与 Coturn，**不要写入网页或提交到前端仓库**。
- 没有可用 TURN 凭据时，客户端仍会尝试直连和配置的 STUN，但需要中继的网络可能失败。请使用支持动态凭据的服务端，并检查公网 TURN 地址、密钥配置和时间是否正确。

<details>
<summary>连接与交互参数默认值</summary>

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `signalingUrl` | `wss://api.crossdesk.cn:9099` | 信令地址 |
| `iceServers` | `[{ urls: ["stun:api.crossdesk.cn:3478"] }]` | 旧服务端未下发会话 ICE 配置时的基础列表 |
| `heartbeatIntervalMs` | `3000` | 心跳发送间隔 |
| `heartbeatTimeoutMs` | `10000` | 心跳响应超时 |
| `reconnectDelayMs` | `2000` | 信令重连初始延迟，随后指数增加 |
| `reconnectMaxDelayMs` | `30000` | 信令重连延迟上限 |
| `reconnectMaxAttempts` | `8` | 连续信令重连尝试上限，WebSocket 打开后重置计数 |
| `connectionTimeoutMs` | `20000` | 远程会话连接超时 |
| `iceDisconnectedTimeoutMs` | `5000` | ICE 短暂断开后的恢复等待时间 |
| `interactionGuardEnabled` | `true` | 是否拦截指定区域的浏览器默认交互 |
| `interactionGuardScope` | `"video"` | 拦截区域：`video` / `global` / `none`；输入框保留编辑能力 |
| `clientTag` | `"web"` | 浏览器登录标识，不是要连接的远程设备 ID |

所有 `Ms` 参数单位均为毫秒。交互拦截用于避免视频区域内的选择、拖动、复制等浏览器默认行为。剪贴板同步通过独立可靠通道实现；浏览器权限与使用方式见[用户指南](USER_GUIDE.md#剪贴板)。

</details>

<a id="development"></a>

## 开发与验证

| 文件 | 职责 |
| --- | --- |
| [index.html](../index.html) / [styles.css](../styles.css) | 连接表单、远程画面与触控界面 |
| [web_client.js](../web_client.js) | 信令、WebRTC、连接状态、音频和画面切换 |
| [file_transfer.js](../file_transfer.js) | 文件通道协商、分块收发、确认流控及取消 |
| [file_download.js](../file_download.js) / [file_download_sw.js](../file_download_sw.js) | 以带背压的下载流交给浏览器，沿用默认下载目录及保存设置 |
| [session_controls.js](../session_controls.js) | 悬浮菜单、画面设置、网络状态、显示器选择与断开确认 |
| [control.js](../control.js) | 控制协议、物理 / 虚拟键鼠、鼠标锁定与触控缩放 |
| [turn_credentials.js](../turn_credentials.js) | 动态 TURN 凭据校验与 ICE 配置生成 |
| [tests/turn_credentials_test.js](../tests/turn_credentials_test.js) | TURN 凭据解析测试 |
| [tests/control_touch_test.js](../tests/control_touch_test.js) | 触控点击、移动与缩放的事件回归测试 |
| [tests/web_client_signaling_test.js](../tests/web_client_signaling_test.js) | Answer 及时发送、候选补发与连接取消的信令回归测试 |
| [vendor/README.md](../vendor/README.md) | WebRTC Adapter 的版本与来源 |

安装 Node.js 后，可以直接运行现有测试和语法检查，无需安装依赖：

```bash
node tests/turn_credentials_test.js
node tests/control_touch_test.js
node --test tests/web_client_signaling_test.js
node --check web_client.js
node --check control.js
node --check turn_credentials.js
node --check file_download.js
node --check file_download_sw.js
node --check file_transfer.js
node --check session_controls.js
```

这些检查覆盖凭据解析、模拟触控事件、模拟 WebRTC 信令与脚本语法，不能替代真实设备上的连接、音视频和输入测试。修改连接或触控逻辑后，应使用同一服务上的桌面端验证直连 / TURN、画面切换、断开重连和对应输入设备。

WebRTC Adapter 固定为 **9.0.1**：页面优先加载本地 `vendor/adapter-9.0.1.min.js`，失败时回退到同版本的 jsDelivr 地址。部署时保留 `vendor` 资源，版本更新时同时核对本地文件与 [index.html](../index.html) 中的回退地址。

## 文件传输互通要求

Web 文件传输需要桌面端使用支持将已注册文件流映射为 WebRTC DataChannel 的 MiniRTC，并重新构建桌面端。仅发布网页无法让旧桌面端接收文件；网页会在文件通道未就绪时禁用发送并提示更新。服务器无需增加文件上传接口，文件通过当前会话的 WebRTC 数据通道传输。

文件通道与 PC 端共用 `AddDataStream("file", true)` 和 `AddDataStream("file_feedback", true)` 注册信息。被控端建立 WebRTC 连接时，直接为这两个已注册文件流创建 DataChannel，可靠性沿用注册配置，协议标识为 `crossdesk-file-v1`，收到的二进制数据交给已有桌面端文件收发逻辑。不再使用额外的 `file_transfer_version` 字段，也不依赖 `web_qos_hello`；该握手仅用于原有输入与 QoS 能力。浏览器在两个文件通道就绪后启用传输，等待超时则提示升级被控端。PC 原生传输仍使用原有底层传输，文件格式、通道名称及上层处理保持共用。

二进制数据沿用 CrossDesk 的小端 31 字节文件头和 28 字节确认包。Web 发送按块读取，最多保留 1 MiB 未确认数据，只有收到完成确认才显示发送完成。接收文件自动进入浏览器下载管理器，边接收边写入默认下载目录，无需选择接收目录或点击保存，不再限制为 256 MiB。接收队列上限为 8 MiB；下载流按块确认并施加背压，页面不缓存整个文件。界面完成表示数据已交付浏览器，请在下载列表中确认最终保存结果。断开或刷新会中止未完成的传输，完成的下载不受影响。不支持断点续传或目录传输。

流式接收要求支持 Service Worker 的浏览器及 HTTPS 或 localhost；`file://` 和普通远程 HTTP 页面不能接收。`file_download_sw.js` 必须与入口页面部署在同一目录，以 JavaScript MIME 类型返回，不可被 SPA 回退页替代。Worker URL 沿用 `file_download.js` 的版本参数，发布时需同步上传两个文件。浏览器若开启“每次询问保存位置”或多文件下载权限提示，仍按浏览器设置执行。下载被拦截或取消时传输会失败，请允许下载后重试。
