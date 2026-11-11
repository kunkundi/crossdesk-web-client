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

1. Open **文件传输 (File transfer)** from the floating menu. Hosts supporting Web directory browsing use the centered dual-pane dialog described below; legacy hosts use the original **选择文件并发送 (Select files and send)** panel and task list. Closing either view keeps transfers running; disconnecting closes it automatically.
2. Choose a local folder on the left. Browsers supporting directory access request read/write permission for that folder and its descendants only. The path is relative to the selected root; the browser cannot reveal its absolute disk path. Use the folder button beside the path to change roots or select individual files.
3. Both panes support path entry, parent navigation, name filtering, hidden files, and a folder tree. Double-click a folder or use **打开目录 (Open folder)** from its context menu. Files have no context menu. Sort by name, modification date, or size; dates use `YYYY/MM/DD`. Large remote directories load through snapshot pagination and virtualized rows, including entries beyond 2000.
4. Select files or folders in one pane and click **发送到远端 (Send to remote)** / **发送到本机 (Send to local)**, or drag them across panes. System files can also be dropped onto the remote pane. The other pane's current folder is the destination. Press Enter after editing a path before sending.
5. Recursive folder transfers preserve empty directories, merge existing folders, and save duplicate filenames separately. Each operation permits up to 256 selected paths and 4096 files/directories. Symbolic links and resume are unsupported. The entire selection is validated before queueing.
6. The task area shows both outgoing and incoming transfers. It expands automatically for the first task and can be collapsed manually. Sending progress uses acknowledged bytes and completes after the remote receiver's final save acknowledgment. Receiving progress uses locally written bytes, then shows **正在保存 (Saving)** until the save operation completes. For browser downloads, check the browser's download list for the final save result. Each task identifies its direction, with size following the filename. Cancel a transfer, remove one finished record, or use **清除已完成 (Clear completed)**. The latest 100 terminal records are retained. Clearing history does not delete saved files. Closing the dialog keeps transfers running without an extra receiving progress panel or floating-menu notification; reopen it to view progress and results.

**Browser differences:** Use HTTPS or localhost. Browsers exposing `showDirectoryPicker` can read/write a user-authorized directory and receive complete folders. Other browsers can select files or folders for sending; directory inputs omit empty folders. Incoming files use streaming browser downloads. The page cannot browse that download location or preserve incoming folder hierarchies, so receiving folders requires a browser supporting directory access and an authorized destination. Downloads without a directory grant require Service Workers and may need permission for multiple downloads. Unsolicited files sent without a prepared directory destination also use browser downloads.

**Older clients:** Like the desktop client, the Web client selects the UI using host-information capabilities, without guessing versions or probing with directory requests. Hosts that omit directory support, or support only native directories without the Web directory channel, use the original file-transfer panel: select files, view sending/receiving progress, cancel transfers, or remove records. Sent files use the remote default receive directory; incoming files use browser downloads. Opening this panel does not grant remote access to local directories. A file picker opened in a previous connection cannot send to a replacement session. File chunks, acknowledgments, and cancellation keep the original wire protocol. Hosts without Web file channels show an upgrade message.

Receiving streams chunks without buffering complete files or imposing a fixed 256 MiB limit. Transfers time out after 30 seconds without progress; directory RPCs time out after 12 seconds. **Disconnecting, reconnecting, or reloading stops transfers and releases session-local directory references; completed files remain. Closing only the file dialog keeps transfers running.** Check the browser download list for final save results when using browser downloads.

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
