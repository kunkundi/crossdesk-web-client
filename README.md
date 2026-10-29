# CrossDesk Web Client

在浏览器中通过设备 ID 和密码连接 [CrossDesk](https://github.com/kunkundi/crossdesk) 桌面客户端，接收远程画面与音频，并使用键盘、鼠标或触控设备操作电脑。

[打开 Web 客户端](https://web.crossdesk.cn/) · [English](README_EN.md) · [下载桌面端](https://github.com/kunkundi/crossdesk/releases) · [自建服务端](https://github.com/kunkundi/crossdesk-server)

[![License: LGPL v3](https://img.shields.io/badge/license-LGPL--3.0-blue)](LICENSE)
[![GitHub last commit](https://img.shields.io/github/last-commit/kunkundi/crossdesk-web-client)](https://github.com/kunkundi/crossdesk-web-client/commits/main)
[![GitHub Pages](https://img.shields.io/github/deployments/kunkundi/crossdesk-web-client/github-pages)](https://github.com/kunkundi/crossdesk-web-client/deployments/github-pages)
[![GitHub issues](https://img.shields.io/github/issues/kunkundi/crossdesk-web-client)](https://github.com/kunkundi/crossdesk-web-client/issues)

[快速连接](#quick-start) · [操作指引](#controls) · [本地运行](#local) · [部署](#deployment) · [自建服务器配置](#configuration) · [常见问题](#troubleshooting) · [开发与验证](#development)

## 当前能力

| 功能 | 说明 |
| --- | --- |
| 浏览器远程控制 | Web 端作为控制端，被控电脑运行 CrossDesk 桌面客户端 |
| 画面与音频 | WebRTC 视频、远端音频播放，以及接收到多个视频轨道时的画面切换 |
| 桌面操作 | 鼠标移动、按键、滚轮与物理键盘输入 |
| 移动端操作 | 相对 / 绝对鼠标模式、虚拟鼠标、虚拟键盘、画面缩放和平移 |
| 文件传输 | 双向传输、多文件发送队列、进度与取消；需桌面端及 MiniRTC 支持 Web 文件通道 |
| 剪贴板 | 双向纯文本同步、手动发送与复制，支持中文；需桌面端支持 Web 剪贴板同步 |
| 连接恢复 | 信令心跳与自动重连，远程连接超时提示及手动重试 |
| 自托管 | 静态网页部署，自定义 WSS 地址，服务端会话 ICE 配置与临时 TURN 凭据 |

项目使用原生 HTML、CSS 和 JavaScript，**无需 npm 安装或打包构建**。当前页面为中文；不支持把浏览器作为被控端。

<a id="quick-start"></a>

## 快速连接

1. 在被控电脑安装并启动 [CrossDesk 桌面端](https://github.com/kunkundi/crossdesk/releases)，确认已连接服务器，并授予屏幕捕获和远程输入所需的系统权限。
2. 打开 [Web 客户端](https://web.crossdesk.cn/)，输入被控端当前显示的**远程设备 ID** 和 **6 位密码**。ID 中的空格会自动去除。
3. 等待页面完成信令连接与登录，点击“连接”或按 Enter。按钮启用需要同时满足：信令就绪、ID 非空、密码长度为 6。
4. 出现远程画面后开始操作；结束时展开浮动控制栏，点击“断开连接”并确认。

当前桌面端已自动启用 SRTP；浏览器 WebRTC 要求媒体加密，使用自定义或旧被控端时需确保支持并启用。

使用自建服务器时，两端必须接入同一套信令服务。仅 Fork 或部署网页不会自动搭建服务端，也不会自动修改被控端的服务器设置。

<a id="controls"></a>

## 会话操作

点击 CrossDesk 悬浮图标展开菜单，拖动图标调整位置。

| 入口 | 用途 |
| --- | --- |
| 键盘 / 虚拟鼠标 | 电脑使用物理键鼠，触控设备使用虚拟按键、点击、滚动与拖动 |
| 鼠标模式 | 默认相对移动，可切换绝对位置 |
| 画面设置 | 调整画质、帧率及流畅 / 画质策略，可用项取决于被控端支持 |
| 网络状态 / 显示器 | 查看实时连接指标，切换收到的视频轨道 |
| 文件传输 | 选择文件发送到远端，接收文件流式保存到浏览器下载目录，取消或移除传输记录 |
| 音频 / 断开连接 | 播放或静音远端音频，确认后结束会话 |

触控手势、鼠标锁定、缩放、音频及控件可用条件见 [操作指南](docs/USER_GUIDE.md#controls)。

<a id="local"></a>

## 本地运行

安装 Git 和 Python 3 后执行：

```sh
git clone https://github.com/kunkundi/crossdesk-web-client.git
cd crossdesk-web-client
python3 -m http.server 8080 --bind 127.0.0.1
```

打开 [本地页面](http://127.0.0.1:8080/)。这是使用默认公共信令的本机预览，不会启动信令服务；按 Ctrl+C 停止。

<a id="deployment"></a>

## 部署网页

使用 HTTPS 静态托管，运行站点无需 Node.js。按原路径上传 `index.html`、`styles.css`、**七个应用脚本**（`control.js`、`turn_credentials.js`、`file_download.js`、`file_transfer.js`、`clipboard.js`、`web_client.js`、`session_controls.js`）、下载流处理脚本 `file_download_sw.js`、`vendor/`、`icons/`、`favicon.ico` 和 `manifest.json`。

GitHub Pages 选择发布分支及 `/(root)`。使用 GitHub 默认域名时删除官方 `CNAME`，自定义域名则在 Pages 中配置；自定义域名或子路径还需检查站点元数据及 manifest 的启动地址。

[完整部署步骤](docs/DEPLOYMENT.md#deployment) · [发布版本与缓存更新](docs/DEPLOYMENT.md#查看和更新-web-版本)

<a id="configuration"></a>

## 接入自建服务

先部署 [CrossDesk Server](https://github.com/kunkundi/crossdesk-server) 与 Coturn，在应用脚本之前设置 `window.CROSSDESK_CONFIG`，让被控桌面端使用同一信令服务，并确保浏览器信任 WSS 证书。

当前服务端下发完整会话 ICE 列表及临时 TURN 凭据，额外 STUN / TURN 节点应配置在服务端；本地 `iceServers` 用于兼容旧服务端。TURN 共享密钥仅保留在服务器。

[配置指南](docs/DEPLOYMENT.md#configuration) 提供可复制的覆盖示例、证书检查及全部默认参数。修改 `index.html` 时保留 `session_controls.js` 和脚本版本参数。

<a id="troubleshooting"></a>

## 常见问题

先检查信令登录和证书信任，再核对被控端当前 ID / 密码、屏幕与输入权限、STUN / TURN 网络。能打开网页或 HTTPS 状态接口，不代表远控链路已经打通。

[排查表](docs/USER_GUIDE.md#troubleshooting) 覆盖按钮不可用、登录失败、无画面 / 声音、触控、旧配置缓存及 ICE 诊断。

<a id="development"></a>

## 开发与验证

[开发指南](docs/DEPLOYMENT.md#development) 列出源码分工、现有 Node.js 测试与语法检查命令，无需安装依赖。音视频、输入及直连 / 中继仍需使用真实电脑和移动设备验证。

## 反馈与许可

[提交问题](https://github.com/kunkundi/crossdesk-web-client/issues)时，请说明浏览器与系统版本、桌面端与服务端版本、公共 / 自建部署方式、具体提示和脱敏后的控制台日志。项目使用 [LGPL-3.0](LICENSE) 许可。
