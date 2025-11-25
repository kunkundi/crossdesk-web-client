# CrossDesk

[![License: LGPL v3](https://img.shields.io/badge/License-LGPL%20v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)
[![GitHub last commit](https://img.shields.io/github/last-commit/kunkundi/crossdesk-web-client)](https://github.com/kunkundi/crossdesk/commits/web-client)
[![GitHub Pages Deploy Status](https://img.shields.io/github/deployments/kunkundi/crossdesk-web-client/github-pages)](https://github.com/kunkundi/crossdesk-web-client/deployments/github-pages)  
[![GitHub issues](https://img.shields.io/github/issues/kunkundi/crossdesk-web-client.svg)]()
[![GitHub stars](https://img.shields.io/github/stars/kunkundi/crossdesk-web-client.svg?style=social)]()
[![GitHub forks](https://img.shields.io/github/forks/kunkundi/crossdesk-web-client.svg?style=social)]()


## 简介

CrossDesk Web Client 是针对 CrossDesk 桌面远程软件进行适配的 Web 客户端。

## 部署

直接 Fork 本仓库，进入你的仓库 Settings → Pages，在 Branch 中选择 main，点击 Save。稍作等待后刷新页面，你会得到如下显示，该链接就是你的 Web 客户端地址。

<img width="807" height="197" alt="image" src="https://github.com/user-attachments/assets/da20745e-7c58-41d9-b6f5-31d5f703b8ce" />

## 配置项

web_client.js 中包含配置项：
```
const DEFAULT_CONFIG = {
  signalingUrl: "wss://api.crossdesk.cn:9099",
  iceServers: [
    { urls: ["stun:api.crossdesk.cn:3478"] },
    { urls: ["turn:api.crossdesk.cn:3478"], username: "crossdesk", credential: "crossdeskpw" },
  ],
  heartbeatIntervalMs: 3000,
  heartbeatTimeoutMs: 10000,
  reconnectDelayMs: 2000,
  clientTag: "web",
};
```
在完成[ CrossDesk Server ](https://github.com/kunkundi/crossdesk-server)的部署后，请将配置项中的 signalingUrl 和 iceServers 配置成你的 CrossDesk Server 的外网地址和端口。
```
# signalingUrl
wss://api.crossdesk.cn:9099 替换为 EXTERNAL_IP:CROSSDESK_SERVER_PORT

# iceServers
api.crossdesk.cn:3478 替换为 EXTERNAL_IP:COTURN_PORT
```
