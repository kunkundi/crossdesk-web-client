# CrossDesk Web Client

Connect to a [CrossDesk](https://github.com/kunkundi/crossdesk) desktop client from your browser using its device ID and password. View the remote desktop, play remote audio, and control the computer with a keyboard, mouse, or touch device.

[Open Web Client](https://web.crossdesk.cn/) · [中文](README.md) · [Download desktop client](https://github.com/kunkundi/crossdesk/releases) · [Self-host the server](https://github.com/kunkundi/crossdesk-server)

[![License: LGPL v3](https://img.shields.io/badge/license-LGPL--3.0-blue)](LICENSE)
[![GitHub last commit](https://img.shields.io/github/last-commit/kunkundi/crossdesk-web-client)](https://github.com/kunkundi/crossdesk-web-client/commits/main)
[![GitHub Pages](https://img.shields.io/github/deployments/kunkundi/crossdesk-web-client/github-pages)](https://github.com/kunkundi/crossdesk-web-client/deployments/github-pages)
[![GitHub issues](https://img.shields.io/github/issues/kunkundi/crossdesk-web-client)](https://github.com/kunkundi/crossdesk-web-client/issues)

[Quick start](#quick-start) · [Controls](#controls) · [Run locally](#local) · [Deployment](#deployment) · [Server configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Development](#development)

## Current capabilities

| Feature | Details |
| --- | --- |
| Browser remote control | The browser controls a computer running the CrossDesk desktop client |
| Video and audio | WebRTC video, remote audio playback, and display switching when multiple video tracks are received |
| Desktop input | Mouse movement, buttons, scrolling, and physical keyboard input |
| Mobile input | Absolute / relative mouse modes, virtual mouse, virtual keyboard, zoom, and pan |
| File transfer | Bidirectional transfers, a send queue, progress, and cancellation; requires desktop/MiniRTC support for web file channels |
| Clipboard | Bidirectional plain text, manual send/copy, and Unicode; requires desktop support for web clipboard synchronization |
| Connection recovery | Signaling heartbeats and automatic reconnection, remote-session timeouts, and manual retry |
| Self-hosting | Static hosting, custom WSS endpoints, server-issued session ICE configuration, and temporary TURN credentials |

The project uses plain HTML, CSS, and JavaScript: **no npm installation or build step is required**. The current interface is in Chinese. Using the browser as a remote host is not supported.

<a id="quick-start"></a>

## Quick start

1. Install and start the [CrossDesk desktop client](https://github.com/kunkundi/crossdesk/releases) on the remote computer. Confirm it is connected to the server and has the required screen capture and remote input permissions.
2. Open the [Web Client](https://web.crossdesk.cn/) and enter the host's current **device ID** in “远程设备 ID” and **6-character password** in “密码”. Spaces in the ID are removed automatically.
3. Wait for signaling connection and login, then click **连接** (Connect) or press Enter. The button requires signaling to be ready, a nonempty ID, and a password exactly 6 characters long.
4. Start controlling the computer when the remote video appears. To finish, expand the floating controls and click **断开连接** (Disconnect), then confirm.

Current desktop builds enable SRTP automatically. Browser WebRTC media encryption is required; custom or older hosts must support and enable it.

For self-hosting, both clients must use the same signaling service. Forking or deploying this website does not deploy the server or change the desktop client's server settings.

<a id="controls"></a>

## Session controls

Click the floating CrossDesk icon to open the menu; drag it to reposition it.

| Control | Purpose |
| --- | --- |
| Keyboard / virtual mouse | Physical input on desktop; virtual keys, clicks, scrolling, and dragging on touch devices |
| Mouse mode | Relative movement by default; switch to absolute positioning when needed |
| Video settings | Quality level, frame rate, and smoothness/detail preference, subject to host support |
| Network status / displays | Inspect live connection metrics and switch received video tracks |
| File transfer | Send selected files, stream received files to browser downloads, and cancel or remove transfers |
| Audio / disconnect | Play or mute remote audio; confirm before ending the session |

See the [user guide](docs/USER_GUIDE_EN.md#controls) for touch gestures, pointer lock, zoom, audio, and control availability.

<a id="local"></a>

## Run locally

With Git and Python 3 installed:

```sh
git clone https://github.com/kunkundi/crossdesk-web-client.git
cd crossdesk-web-client
python3 -m http.server 8080 --bind 127.0.0.1
```

Open [the local page](http://127.0.0.1:8080/). This serves a local preview using the default public signaling service; it does not start a signaling server. Press Ctrl+C to stop it.

<a id="deployment"></a>

## Deploy the website

Use HTTPS static hosting; no Node.js runtime is required to serve the site. Upload `index.html`, `styles.css`, **all seven application scripts** (`control.js`, `turn_credentials.js`, `file_download.js`, `file_transfer.js`, `clipboard.js`, `web_client.js`, `session_controls.js`), the streaming download worker `file_download_sw.js`, `vendor/`, `icons/`, `favicon.ico`, and `manifest.json`, preserving their paths.

For GitHub Pages, select the publishing branch and `/(root)`. Remove the official `CNAME` when using GitHub's default domain, or configure your own domain in Pages. Custom domains and subpaths also require checking site metadata and the manifest's start URL.

[Complete deployment steps](docs/DEPLOYMENT_EN.md#deployment) · [Release version and cache updates](docs/DEPLOYMENT_EN.md#view-and-update-the-web-version)

<a id="configuration"></a>

## Connect to your own server

Deploy [CrossDesk Server](https://github.com/kunkundi/crossdesk-server) and Coturn first. Set `window.CROSSDESK_CONFIG` before loading the application scripts, configure the same signaling service on the remote desktop, and ensure the browser trusts the WSS certificate.

Current servers issue a complete session ICE list and temporary TURN credentials. Additional STUN / TURN endpoints belong in the server configuration; local `iceServers` is a fallback for older servers. Shared TURN secrets stay on the server.

The [configuration guide](docs/DEPLOYMENT_EN.md#configuration) provides a copyable override example, certificate checks, and all available defaults. Preserve `session_controls.js` and the versioned script tags when editing `index.html`.

<a id="troubleshooting"></a>

## Troubleshooting

Start with signaling login and certificate trust, then verify the host's current ID/password, screen/input permissions, and STUN / TURN reachability. A working web page or HTTPS stats endpoint alone does not verify a remote-control session.

The [troubleshooting table](docs/USER_GUIDE_EN.md#troubleshooting) covers disabled buttons, login failures, missing video/audio, touch input, stale configuration, and ICE diagnostics.

<a id="development"></a>

## Development

The [development guide](docs/DEPLOYMENT_EN.md#development) maps source files and lists existing Node.js tests and syntax checks. No dependency installation is needed. Browser-based regressions still require real desktop and mobile devices to verify media, input, and direct / relay connections.

## Feedback and license

[Report issues](https://github.com/kunkundi/crossdesk-web-client/issues) with browser and OS versions, desktop and server versions, public / self-hosted deployment details, the exact error, and sanitized console logs. The project uses [LGPL-3.0](LICENSE).
