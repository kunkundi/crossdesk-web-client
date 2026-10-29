# Connection and controls

[Project overview](../README_EN.md) · [中文](USER_GUIDE.md)

[Quick start](#quick-start) · [Controls](#controls) · [Troubleshooting](#troubleshooting)

<a id="quick-start"></a>

## Quick start

1. Install and start the [CrossDesk desktop client](https://github.com/kunkundi/crossdesk/releases) on the remote computer. Confirm it is connected to the server and has the required screen capture and remote input permissions.
2. Open the [Web Client](https://web.crossdesk.cn/) and enter the host's current **device ID** in “远程设备 ID” and **6-character password** in “密码”. Spaces in the ID are removed automatically.
3. Wait for signaling connection and login, then click **连接** (Connect) or press Enter. The button requires signaling to be ready, a nonempty ID, and a password exactly 6 characters long.
4. Start controlling the computer when the remote video appears. To finish, expand the floating controls and click **断开连接** (Disconnect), then confirm.

Current desktop builds enable SRTP automatically. Browser WebRTC media encryption is required; custom or older hosts must support and enable it.

For self-hosting, both clients must use the same signaling service. Forking or deploying this website does not deploy the server or change the desktop client's server settings.

<a id="controls"></a>

## Controls

### Desktop browsers

- Click inside the remote video to use your mouse and physical keyboard. Supported browsers request pointer lock; press **Esc** to release the pointer and return to page controls. Behavior depends on the browser's [Pointer Lock support](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API).
- Use left / middle / right mouse buttons and the scroll wheel. Keyboard input is sent as key events; some shortcuts reserved by the OS or browser may not reach the host.
- Click the floating CrossDesk icon to open or close the menu; drag it to reposition it. Click outside the menu or its close button to close it. Esc returns from a subpage to the main menu, or closes the main menu.

### Phone and tablet browsers

**Tap the video with one finger to left-click or two fingers to right-click; slide to move the pointer.** You can also click with the virtual mouse buttons.

| Action | How to use it |
| --- | --- |
| Absolute positioning | Click the mouse-mode button until it shows “绝对鼠标”; touch position maps to the remote pointer position |
| Relative movement | The default is “相对鼠标”; slide on the video to move the pointer by relative displacement |
| Left / right click | Tap the video with one finger for left-click or two fingers for right-click; virtual “左键” / “右键” buttons also work |
| Drag | Press and slide from the virtual “左键” button; release to finish dragging |
| Scroll | Use ↑ / ↓ on the virtual mouse; hold for continuous scrolling |
| Type keys | Tap “键盘” in the menu or ⌨ on the virtual mouse; drag the keyboard header to move it, or tap × to close it |
| Zoom / pan | Pinch the video to zoom between 1× and 3×, and move two fingers to pan; double-tap to reset zoom |
| Minimize virtual mouse | Toggle “虚拟鼠标” in the floating menu |

The touch layout uses the browser's pointer and hover capabilities, not screen size alone. The virtual keyboard sends key codes and does not provide a local input-method text submission interface.

### Switch displays and play audio

- **Display:** open “显示器” in the menu and choose a received video track. Available options depend on the host's video tracks, and switching is enabled after the control data channel opens.
- **Audio:** the audio button remains disabled until a remote audio track arrives. If autoplay is blocked, click it to start playback; click again to mute. It controls browser playback, not the remote computer's system volume.
- **Disconnect:** open “断开连接” and confirm to return to the form; cancel to keep the session. Signaling reconnection and remote-session establishment are separate; if a remote session fails and returns to the form, click Connect again.

### Video settings and network status

- **画面设置 (Video settings):** choose a low / medium / high quality level, a 30 / 60 FPS limit, and “帧率优先” (frame rate), “画质优先” (detail), or “平衡” (balance). Availability depends on the host's reported capabilities. Unsupported controls are disabled; wait for acknowledgment before judging the result, and retry if the menu reports failure.
- **网络状态 (Network status):** view resolution, frame rate, received video bitrate, packet loss, RTT, video buffering, decode time, and the direct / relay route. Relayed routes also show their transport. Values depend on the browser statistics and available media; an unavailable metric is not necessarily zero.
- **显示器 (Displays):** lists tracks supplied by the host; the page cannot expose a display the host is not sending.

These controls use [session_controls.js](../session_controls.js), which loads after `web_client.js`. Keep it in manual deployments.

### File transfer

1. Open **文件传输 (File transfer)** from the floating menu. The desktop must include MiniRTC support for web file channels; older hosts display an update notice and leave sending disabled.
2. Click **选择文件并发送 (Select files and send)** to queue one or more files. Progress reflects bytes acknowledged by the host; completion requires its final acknowledgment. Files go to the desktop's configured receive directory (Desktop by default).
3. When the host sends to this web session, the file automatically streams to the browser’s default download location, without a directory picker or Save button. A blue dot appears on the floating icon; open File transfer to see progress. Download names are sanitized, and the browser handles duplicate filenames.
4. Use **取消 (Cancel)** for queued or active transfers and **× (Remove)** for finished records. Transfers fail after 30 seconds without progress and must be sent again.

The **256 MiB** receive limit is removed. The page processes chunks without buffering entire files; actual capacity depends on the browser and available disk space. Up to 100 records are retained. Removing a record does not delete a completed download. Folder transfers and resume are not supported.

Open the page over **HTTPS or localhost** with a browser that supports Service Workers. Opening the HTML directly (`file://`) cannot stream received files. If the browser asks where to save each download, that setting still applies. Multiple downloads may require allowing downloads for this site. If a download is blocked or cancelled, allow downloads and send the file again.

**Disconnecting, reconnecting, or refreshing stops active transfers and downloads; completed downloads remain.** Completion in the page means the bytes have been handed to the browser. Check the browser download list for the final save result.

### Clipboard

Open **剪贴板** (Clipboard) in the remote-control menu. Synchronization requires host support. Older hosts remain usable for remote control and keyboard shortcuts; only clipboard synchronization is unavailable. The web client does not send clipboard protocol messages over a legacy control channel.

- Local to remote: use Ctrl+V, Command+V, or Shift+Insert over the remote video. Text is sent first; the original paste shortcut is forwarded only after the host confirms its OS clipboard was updated. Use a shortcut appropriate for the host OS.
- Manual send: expand **手动传递文本**, click **发送到远端**, then paste in the remote application. Alternatively, paste/type into **发送文本** and click **发送**.
- Remote to local: copy text on the host, expand **手动传递文本**, then click **复制到本机**, or select the received text and copy it manually. The relevant text area opens automatically when clipboard access is unavailable or denied.
- The **自动同步** switch is on by default for each new connection and can be turned off for the current connection. With persistent browser clipboard grants, it runs while the page is focused and visible. Safari, Firefox, denied permissions, or insecure pages can use the buttons/text areas under **手动传递文本**. System clipboard API access requires HTTPS or localhost.

Each value is limited to 128 KiB of UTF-8 plain text, including Unicode and newlines. Images, files, rich text, empty values, and embedded NUL are not transferred. No clipboard content is persisted; disconnect/reconnect clears the cache and text areas. Leaving the page, clicking elsewhere, or pressing another key cancels a pending paste. The Windows SYSTEM unattended host continues to block clipboard access.

<a id="troubleshooting"></a>

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Connect button disabled | Signaling login must finish, the device ID must be nonempty, and the password must contain 6 characters; a blank form normally has a disabled button |
| Cannot connect to server / repeated retries | Verify the signaling scheme, host, port, certificate, server status, and proxy WebSocket support; then click “重连服务器” (Reconnect to server) |
| “没有该设备” (No such device) | Both clients must use the same signaling service, and the host must be online under the entered ID |
| “密码错误” (Incorrect password) | Use the host's current 6-character password; check whether it has been refreshed |
| Connection timeout / no video | Check host screen capture permissions and SRTP, then STUN / TURN, dynamic credentials, and relay ports |
| Video works but input or display switching fails | Check that the control data channel is open and the host has remote input permissions |
| Tapping the video does not click on mobile | Briefly tap and release one / two fingers for left / right click; sliding, holding, and pinching do not click. Virtual mouse buttons also work |
| No sound | Check that the host provides an active audio track, then the audio button, site playback permissions, and local volume |
| Configuration changed but old server still used | Verify override script order and deployment completion; force-refresh and inspect the downloaded HTML / JS |
| Wrong fork URL or home-screen launch path | Check Pages Custom domain, `CNAME`, publishing directory, and the manifest's `start_url` |

### Diagnose direct connectivity

Starting when an `RTCPeerConnection` is created, `window.CrossDeskIceDiagnostics` records ICE states, candidate types, IPv4 / IPv6 / mDNS families, connectivity check results, and STUN / TURN error codes in memory, even before video arrives. The last peer's diagnostics survive disconnection and reset on the next connection attempt. Inspect them in the browser developer console:

```js
JSON.stringify(window.CrossDeskIceDiagnostics, null, 2)
```

`first_route` is the first observed route; `route` is the current route; `route_at_30s` is the first route sampled at least 30 seconds after peer creation, or `null` if the connection ends earlier. `candidate_pairs` helps distinguish missing candidates, failed checks, and relay selection. Diagnostics exclude device IDs, candidate IP addresses, full SDP, and credentials, and are not uploaded automatically. Candidate and event lists are bounded. Compare repeated connections on the same devices and networks to measure direct-connect rates.

The web client buffers candidates arriving before the Offer or remote description and uses session identifiers and `ufrag` to isolate generations. Legacy servers may omit these fields; untagged stale messages from the same device cannot be fully distinguished. Updated hosts also gather candidates immediately after sending the Offer and offer ICE-TCP direct candidates. These host changes require rebuilding the desktop client and MiniRTC.
