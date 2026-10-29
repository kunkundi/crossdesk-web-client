# Deployment and development guide

[Project overview](../README_EN.md) · [中文](DEPLOYMENT.md)

[Run locally](#local) · [Deployment](#deployment) · [Server configuration](#configuration) · [Development](#development)

<a id="local"></a>

## Run locally

With Git and Python 3 installed:

```bash
git clone https://github.com/kunkundi/crossdesk-web-client.git
cd crossdesk-web-client
python3 -m http.server 8080 --bind 127.0.0.1
```

Open the [local page](http://127.0.0.1:8080/) and press Ctrl+C in the terminal to stop the server. This command serves a development preview on your own computer. The page still uses the default public signaling and STUN configuration in [web_client.js](../web_client.js). Override it as described below for your own server; use HTTPS static hosting for public deployment.

<a id="deployment"></a>

## Deployment

### GitHub Pages

1. Fork this repository. To use the GitHub-provided domain, delete the fork's [CNAME](../CNAME), which names `web.crossdesk.cn`, and leave **Settings → Pages → Custom domain** empty. For your own domain, configure it in Pages and set up DNS.
2. For a self-hosted server, apply the configuration below and commit it to your publishing branch.
3. In **Settings → Pages → Build and deployment → Source**, select **Deploy from a branch**, `main` (or your publishing branch), and **`/(root)`**, then **Save**.
4. Wait for deployment, open the URL shown in Pages, and confirm **Enforce HTTPS** is enabled. Check Actions for deployment failures.

See GitHub's [publishing source instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) and [HTTPS documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https).

### View and update the Web version

The connection form footer and expanded session control panel show the Web version, for example **version 2026.09.24.1** (a format example, not the latest release). Use `year.month.day.release-number`, incrementing the last number for another release on the same day. The loaded `web_client.js` supplies the label, even when signaling is unavailable.

Before each release, run from the repository root (requires Node.js), substituting the version you are publishing:

```bash
node scripts/set-version.js 2026.09.24.2
```

This updates the version in `web_client.js` and the CSS / JS `?v=` cache keys in `index.html`. Commit and deploy the generated changes together with the release, then refresh the live page and confirm its displayed version. Include these files in manual deployments too; preserve the current `?v=` parameters when adapting the configuration example below.

### Other static hosting

Upload these resources to your HTTPS site, preserving their relative paths. The entry point is `index.html`:

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

The website serves static files. CrossDesk Server and Coturn provide WSS signaling and STUN / TURN. If you put WSS behind a reverse proxy, it must support WebSocket upgrades and route the path used by `signalingUrl`.

**Custom domains or subpaths:** [index.html](../index.html) contains the official URL in its canonical, social, and structured-data metadata, as do [robots.txt](../robots.txt) and [sitemap.xml](../sitemap.xml). Update these for your own site. The current [manifest.json](../manifest.json) uses `/` as `start_url`; for a subpath such as `/crossdesk-web-client/`, change it to `./` or the actual site path so home-screen launches open the correct page. File reception uses a same-directory Service Worker for streaming downloads only; it does not cache site assets or enable offline remote control.

<a id="configuration"></a>

## Self-hosted server configuration

### 1. Configure WSS and STUN

Deploy signaling and Coturn with the [CrossDesk Server instructions](https://github.com/kunkundi/crossdesk-server/blob/HEAD/README_EN.md#run-services), then configure the remote desktop client to use that service.

Default endpoints are in `DEFAULT_CONFIG` in [web_client.js](../web_client.js). To override them, insert the following block near the bottom of [index.html](../index.html), **before the existing `control.js` script tag**. Keep all existing script tags and their `?v=` parameters. The application scripts must retain this order: `control.js` → `turn_credentials.js` → `file_download.js` → `file_transfer.js` → `clipboard.js` → `web_client.js` → `session_controls.js`.

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

Replace the example IP `203.0.113.10` with your public IP or hostname. Keep the **`wss://`** and **`stun:`** prefixes. These ports match the current server Compose defaults; update them if your deployment uses different ports.

Configuration uses a shallow merge: omitted fields keep their defaults, while `iceServers` replaces the entire array. There is no automatic `.env` loading, URL-parameter configuration, or server settings form. Republish and refresh the page after changing its scripts.

### 2. Configure certificate trust and networking

- Both page HTTPS and signaling WSS require certificates accepted by the browser. A valid website certificate does not validate WSS on a different hostname or port.
- For a self-signed deployment, install and trust the server's root certificate on the browsing device, and ensure the certificate covers the hostname or IP in `signalingUrl`. Follow the [server certificate instructions](https://github.com/kunkundi/crossdesk-server/blob/HEAD/README_EN.md#clients). The page has no certificate import or verification bypass switch.
- First open `https://your-signaling-host:9099/stats` in the same browser and check that JSON loads without certificate errors. This verifies HTTPS reachability only; an actual remote session is still needed to verify WebSocket and media connectivity.
- Open the configured WSS TCP port, STUN / TURN TCP and UDP ports, and Coturn's UDP relay range. Loading the website alone does not verify the remote-control network path.

### 3. Dynamic TURN credentials

Newer signaling servers include a complete version-1 session configuration in the Offer's `ice` field. After validating its expiry, the browser uses all supplied STUN / TURN endpoints, **replacing local `iceServers` and legacy TURN credentials**. An empty list permits host candidates only; malformed or nearly expired lists require a retry. Configure backup STUN endpoints on the server so web and desktop clients use the same endpoints.

The following applies to older servers that omit the `ice` field:

Normally, configure only STUN in `iceServers`. The signaling service sends temporary TURN credentials during login and session negotiation. The browser validates them with [turn_credentials.js](../turn_credentials.js), keeps them in memory, and adds UDP / TCP TURN URLs when creating a WebRTC connection.

- Fields are `host`, `port`, `username`, `password`, and `expires_at` (Unix seconds). Expired credentials are not used for new connections.
- Updating in-memory credentials and connection configuration does not directly interrupt an established connection. Subsequent relay use still depends on credential validity and server state.
- Configure `COTURN_AUTH_SECRET` only on the signaling server and Coturn. **Do not put it in the page or commit it to the frontend repository.**
- Without usable TURN credentials, the client still tries direct connectivity and configured STUN servers, but networks requiring a relay may fail. Use a server supporting dynamic credentials, and verify its public TURN address, shared secrets, and clock.

<details>
<summary>Connection and interaction defaults</summary>

| Setting | Default | Purpose |
| --- | --- | --- |
| `signalingUrl` | `wss://api.crossdesk.cn:9099` | Signaling endpoint |
| `iceServers` | `[{ urls: ["stun:api.crossdesk.cn:3478"] }]` | Base list for older servers without session ICE configuration |
| `heartbeatIntervalMs` | `3000` | Heartbeat interval |
| `heartbeatTimeoutMs` | `10000` | Heartbeat response timeout |
| `reconnectDelayMs` | `2000` | Initial signaling retry delay, followed by exponential backoff |
| `reconnectMaxDelayMs` | `30000` | Maximum signaling retry delay |
| `reconnectMaxAttempts` | `8` | Consecutive signaling retry limit; resets when WebSocket opens |
| `connectionTimeoutMs` | `20000` | Remote-session connection timeout |
| `iceDisconnectedTimeoutMs` | `5000` | Recovery window after a transient ICE disconnection |
| `interactionGuardEnabled` | `true` | Suppress default browser interactions in the selected scope |
| `interactionGuardScope` | `"video"` | Scope: `video` / `global` / `none`; input fields remain editable |
| `clientTag` | `"web"` | Browser login identifier, not the remote device ID |

All `Ms` values are in milliseconds. Interaction guards prevent browser actions such as selection, dragging, and copying in the video area. Clipboard synchronization uses a separate reliable channel; see the [user guide](USER_GUIDE_EN.md#clipboard) for browser permissions and usage.

</details>

<a id="development"></a>

## Development and validation

| File | Responsibility |
| --- | --- |
| [index.html](../index.html) / [styles.css](../styles.css) | Connection form, remote video, and touch interface |
| [web_client.js](../web_client.js) | Signaling, WebRTC, connection state, audio, and display switching |
| [file_transfer.js](../file_transfer.js) | File channel negotiation, chunked transfer, acknowledgments, and cancellation |
| [file_download.js](../file_download.js) / [file_download_sw.js](../file_download_sw.js) | A download stream with backpressure, using the browser’s default download location and save settings |
| [session_controls.js](../session_controls.js) | Floating menu, video preferences, network metrics, display selection, and disconnect confirmation |
| [control.js](../control.js) | Control protocol, physical / virtual input, pointer lock, and touch zoom |
| [turn_credentials.js](../turn_credentials.js) | TURN credential validation and ICE configuration generation |
| [tests/turn_credentials_test.js](../tests/turn_credentials_test.js) | TURN credential parser tests |
| [tests/control_touch_test.js](../tests/control_touch_test.js) | Touch click, movement, and zoom event regression tests |
| [tests/web_client_signaling_test.js](../tests/web_client_signaling_test.js) | Prompt answer delivery, trickled candidates, and connection cancellation tests |
| [vendor/README.md](../vendor/README.md) | WebRTC Adapter version and source |

With Node.js installed, run the existing tests and syntax checks without installing dependencies:

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

These checks cover credential parsing, simulated touch events, simulated WebRTC signaling, and script syntax, not live connectivity, media, or input. After changing connection or touch logic, use a desktop host on the same service to verify direct / TURN connections, display switching, disconnect/reconnect behavior, and the relevant input devices.

WebRTC Adapter is pinned to **9.0.1**. The page first loads `vendor/adapter-9.0.1.min.js`, then falls back to the same version on jsDelivr if local loading fails. Include the `vendor` asset in deployments, and update the local file and [index.html](../index.html) fallback together when changing versions.

## File transfer interoperability

Rebuild the desktop client with MiniRTC support for mapping registered file streams to WebRTC DataChannels. Publishing the website alone does not enable uploads to older desktop builds; the page disables sending until file channels are ready and prompts for an update when unavailable. No server upload endpoint is needed: files travel over the current WebRTC session.

File channels share the PC registrations `AddDataStream("file", true)` and `AddDataStream("file_feedback", true)`. When establishing a WebRTC connection, the host directly creates DataChannels for these registered file streams, preserving their reliability settings and using protocol `crossdesk-file-v1`. Binary messages go to the existing desktop transfer engine. No additional `file_transfer_version` field or `web_qos_hello` is required for file transfer; the hello remains for input and QoS capabilities. The browser enables transfers once both file channels are ready and prompts for a host upgrade if they time out. Native PC sessions retain their existing underlying transport while sharing file formats, stream names, and application handling.

Binary packets use CrossDesk's little-endian 31-byte file header and 28-byte acknowledgment. Uploads read slices with at most 1 MiB outstanding and complete only after the final acknowledgment. Received files automatically stream through the browser download manager to its default download location, without a directory picker or Save button. The previous 256 MiB limit is removed. The receive queue is capped at 8 MiB and acknowledgments follow stream consumption, propagating backpressure without buffering the entire file in the page. Completion means the data has been handed to the browser; check its download list for the final save result. Disconnecting or refreshing aborts active transfers; completed downloads remain. Resume and directory transfers are not supported.

Streaming reception requires a browser with Service Worker support and HTTPS or localhost. It is unavailable on `file://` or plain remote HTTP pages. Serve `file_download_sw.js` from the same directory as the entry page with a JavaScript MIME type; do not replace it with an SPA fallback page. Its URL inherits the version parameter from `file_download.js`; deploy both files together. Browser preferences for asking where to save and permissions for multiple downloads remain in effect. Blocked or cancelled downloads fail the transfer; allow downloads before retrying.
