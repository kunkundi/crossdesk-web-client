// Directory RPC shares libs/controller/src/file_browser.cpp's version 1 contract.
// Browser-local paths are opaque capabilities rooted in a user-selected directory.
(function () {
  "use strict";
  const encoder = new TextEncoder();
  const MAX_ENTRIES = 4096, MAX_SELECTION = 256, MAX_MESSAGE = 60000;
  const errors = {
    timeout: "目录请求超时，请重试。", disconnected: "连接已结束。",
    directory_unavailable: "无法打开目录，请检查路径和访问权限。",
    directory_not_writable: "无法写入目标目录，请重新授权或检查可用空间。",
    file_unreadable: "无法读取文件，请重新选择。", symbolic_link: "暂不支持发送符号链接。",
    too_many_files: "每次最多发送 4096 个文件和目录，请分批选择。",
    too_many_selected: "每次最多选择 256 项，请分批发送。",
    unsupported: "远端暂不支持目录浏览，请更新客户端。",
    pagination_unsupported: "远端未返回完整目录，请更新客户端后重试。",
    listing_expired: "目录快照已过期，请刷新后重试。",
    incomplete_listing: "远端未返回完整目录，请更新客户端后重试。",
    invalid_listing: "远端目录数据无效，请刷新重试。", invalid_path: "目录路径无效。",
    invalid_request: "文件请求无效。", busy: "传输任务较多，请稍后重试。",
    browser_not_open: "请先在另一端打开文件传输窗口。",
    choose_directory: "请先选择本机目录。", folder_download: "接收文件夹需要先授权本机目录，请使用支持目录授权的浏览器。"
  };
  const failure = code => Object.assign(new Error(errors[code] || code), { code });
  const text = value => {
    if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw failure("invalid_path");
    return value;
  };
  const components = value => {
    text(value);
    if (value.startsWith("/") || value.includes("\\") || value.includes(":")) throw failure("invalid_path");
    const parts = value ? value.split("/") : [];
    if (parts.some(part => !part || part === "." || part === "..")) throw failure("invalid_path");
    return parts;
  };
  const join = (path, name) => path + (/[\\/]$/.test(path) ? "" : path.includes("\\") ? "\\" : "/") + name;
  const dateText = stamp => {
    if (!stamp) return "";
    const d = new Date(stamp), pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  class LocalDirectory {
    constructor(handle = null, files = []) {
      this.handle = handle;
      this.base = `/local/${crypto.randomUUID()}`;
      this.name = handle?.name || "已选择的文件";
      this.nodes = new Map([["", { directory: true }]]);
      for (const file of files) {
        const path = file.webkitRelativePath || file.name;
        const parts = components(path);
        for (let i = 1; i < parts.length; i++) this.nodes.set(parts.slice(0, i).join("/"), { directory: true });
        this.nodes.set(path, { directory: false, file });
      }
    }
    relative(path) {
      if (!path || path === this.base) return "";
      if (!text(path).startsWith(this.base + "/")) throw failure("invalid_path");
      const relative = path.slice(this.base.length + 1);
      components(relative);
      return relative;
    }
    display(path) { return this.name + (path?.startsWith(this.base) ? path.slice(this.base.length) : ""); }
    resolveDisplay(path) {
      if (path === this.name || path === "/") return this.base;
      return path.startsWith(this.name + "/") ? this.base + path.slice(this.name.length) : path;
    }
    async directory(path, create = false) {
      if (!this.handle) throw failure("choose_directory");
      let handle = this.handle;
      for (const part of components(this.relative(path))) handle = await handle.getDirectoryHandle(part, { create });
      return handle;
    }
    async list(path = this.base, current = () => true) {
      const relative = this.relative(path), entries = [];
      if (this.handle) {
        const dir = await this.directory(path);
        let pending = [];
        const collect = async handle => {
          if (handle.name.startsWith(".crossdesk-")) return;
          let file = null;
          if (handle.kind === "file") file = await handle.getFile();
          entries.push({ name: handle.name, directory: handle.kind === "directory", size: file?.size || 0,
            modified_ms: file?.lastModified ?? null, modified: dateText(file?.lastModified), link: false });
        };
        for await (const handle of dir.values()) {
          if (!current()) throw failure("disconnected");
          pending.push(collect(handle));
          if (pending.length === 32) { await Promise.all(pending); pending = []; }
        }
        await Promise.all(pending);
      } else {
        const prefix = relative ? relative + "/" : "";
        if (!this.nodes.get(relative)?.directory) throw failure("directory_unavailable");
        for (const [key, node] of this.nodes) {
          if (!key.startsWith(prefix) || key === relative || key.slice(prefix.length).includes("/")) continue;
          entries.push({ name: key.slice(prefix.length), directory: node.directory, size: node.file?.size || 0,
            modified_ms: node.file?.lastModified ?? null, modified: dateText(node.file?.lastModified), link: false });
        }
      }
      path = this.base + (relative ? "/" + relative : "");
      return { ok: true, path, parent: relative ? path.slice(0, path.lastIndexOf("/")) : "", entries, truncated: false };
    }
    async file(path) {
      const relative = this.relative(path);
      if (!this.handle) {
        const file = this.nodes.get(relative)?.file;
        if (!file) throw failure("file_unreadable");
        return file;
      }
      const parts = components(relative), name = parts.pop();
      const dir = await this.directory(this.base + (parts.length ? "/" + parts.join("/") : ""));
      return (await dir.getFileHandle(name)).getFile();
    }
    async collect(paths, current) {
      if (!paths.length || paths.length > MAX_SELECTION) throw failure("too_many_selected");
      const result = [], visited = new Set();
      const add = async (path, relative, directory) => {
        if (!current()) throw failure("disconnected");
        if (visited.has(path)) return;
        visited.add(path);
        if (result.length >= MAX_ENTRIES) throw failure("too_many_files");
        if (directory) {
          result.push({ id: 0, directory: relative });
          const listing = await this.list(path, current);
          for (const entry of listing.entries) await add(join(path, entry.name), relative + "/" + entry.name, entry.directory);
        } else result.push({ file: await this.file(path), directory: relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "" });
      };
      // Parents first: overlapping selections never duplicate a file or flatten its hierarchy.
      for (const path of [...paths].sort((a, b) => a.length - b.length)) {
        const relative = this.relative(path), name = relative.split("/").pop();
        if (!name) throw failure("invalid_path");
        let directory;
        if (!this.handle) directory = this.nodes.get(relative)?.directory;
        else {
          const parent = path.slice(0, path.lastIndexOf("/"));
          try { await (await this.directory(parent)).getDirectoryHandle(name); directory = true; }
          catch (error) { if (!["NotFoundError", "TypeMismatchError"].includes(error.name)) throw error; directory = false; }
        }
        await add(path, name, directory);
      }
      return result;
    }
  }

  class FileBrowserSession {
    constructor(files) {
      this.files = files;
      this.channel = null;
      this.supported = null;
      this.name = "远端";
      this.opened = false;
      this.closed = false;
      this.sequence = 0;
      this.pending = new Map();
      this.snapshots = new Map();
      this.reservations = new Map();
      this.destinations = new Map();
      this.local = null;
      this.serving = Promise.resolve();
      this.serviceCount = 0;
      this.uploading = false;
    }
    notify() { window.CrossDeskFileManager?.update(this); }
    feedback(message, error = false) { window.CrossDeskFileManager?.feedback(this, message, error); }
    get ready() { return !this.closed && this.files.ready && this.channel?.readyState === "open"; }
    bind(channel) {
      if (this.channel === channel) return;
      if (this.channel) { this.close(); return; }
      this.channel = channel;
      channel.addEventListener("message", event => void this.receive(event.data));
      channel.addEventListener("close", () => this.close());
      channel.addEventListener("open", () => this.notify());
    }
    send(message) {
      if (this.closed || this.channel?.readyState !== "open") throw failure("disconnected");
      const data = JSON.stringify({ ...message, type: "file_browser", version: 1 });
      if (encoder.encode(data).length > MAX_MESSAGE || this.channel.bufferedAmount > 1024 * 1024) throw failure("busy");
      this.channel.send(data);
    }
    request(message) {
      if (this.pending.size >= 256) return Promise.reject(failure("busy"));
      const id = ++this.sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(failure("timeout")); }, 12000);
        this.pending.set(id, { resolve, reject, timer });
        try { this.send({ ...message, id }); }
        catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    }
    cancelListing(cursor) {
      if (cursor && !this.closed) void this.request({ op: "list_cancel", cursor }).catch(() => {});
    }
    async listRemote(path, current = () => true, progress = () => {}) {
      let cursor = "", result = null;
      const entries = [], seen = new Set();
      try {
        do {
          if (!current() || this.closed) throw failure("disconnected");
          const page = await this.request({ op: "list", path, pagination: 1, ...(cursor ? { cursor } : {}) });
          cursor = typeof page.next === "string" ? page.next : "";
          if (!current() || this.closed) throw failure("disconnected");
          if (!Array.isArray(page.entries) || page.entries.length > 2000 || typeof page.path !== "string" ||
              typeof page.parent !== "string" || (page.offset !== undefined && page.offset !== entries.length) ||
              (page.total !== undefined && (!Number.isSafeInteger(page.total) || page.total < entries.length + page.entries.length)) ||
              (result && (result.path !== page.path || result.parent !== page.parent || result.total !== page.total))) throw failure("invalid_listing");
          for (const entry of page.entries) {
            if (!entry || typeof entry.name !== "string" || !entry.name || entry.name.includes("\0") ||
                (page.path !== "@roots" && /[\\/]/.test(entry.name)) || typeof entry.directory !== "boolean" ||
                !Number.isSafeInteger(entry.size) || entry.size < 0 || seen.has(entry.name)) throw failure("invalid_listing");
            const path = page.path === "@roots" ? text(entry.path) : join(page.path, entry.name);
            seen.add(entry.name);
            entries.push({ ...entry, path });
          }
          result = page;
          if (page.truncated && !cursor) throw failure("incomplete_listing");
          if (cursor && (!page.entries.length || !page.truncated || cursor.length > 64 ||
              !/^[^:]+:\d+$/.test(cursor) || Number(cursor.split(":")[1]) !== entries.length ||
              (page.total !== undefined && entries.length >= page.total))) throw failure("invalid_listing");
          if (!cursor && page.total !== undefined && page.total !== entries.length) throw failure("invalid_listing");
          progress(entries.length, page.total);
        } while (cursor);
        return { ...result, entries };
      } finally { this.cancelListing(cursor); }
    }
    async receive(data) {
      try {
        if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
        else if (typeof data?.text === "function") data = await data.text();
        if (this.closed || typeof data !== "string" || encoder.encode(data).length > MAX_MESSAGE) return;
        const message = JSON.parse(data);
        if (message?.type === 3) {
          // Native directory support predates the Web control-channel route.
          // Old hosts keep file-channel transfers without timing out on RPC.
          this.supported = message.host_info?.supports_file_browser === true &&
            message.host_info?.supports_web_file_browser === true;
          this.name = message.host_info?.host_name || "远端";
          this.advertise();
          this.notify();
          return;
        }
        if (message?.type !== "file_browser" || message.version !== 1 || !Number.isSafeInteger(message.id) || message.id < 0) return;
        if (message.op === "reply") {
          const pending = this.pending.get(message.id);
          if (!pending || typeof message.ok !== "boolean") return;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.ok) pending.resolve(message); else pending.reject(failure(message.error || "invalid_request"));
        } else if (message.op === "notice") {
          const destination = this.destinations.get(message.transfer_id);
          if (destination) destination.finished = true;
          if (message.ok === false) this.feedback(errors[message.error] || "远端发送失败，请重试。", true);
          this.notify();
        } else if (message.op !== "presentation") {
          if (this.serviceCount >= 512) { this.send({ op: "reply", id: message.id, ok: false, error: "busy" }); return; }
          ++this.serviceCount;
          this.serving = this.serving.then(() => this.serve(message)).catch(() => {}).finally(() => --this.serviceCount);
        }
      } catch (_) { /* Other control messages and malformed peers cannot change directory state. */ }
    }
    advertise() {
      // Advertise only after explicit local selection, and only to a capable host.
      if (!this.ready || !this.supported) return;
      const control = window.CrossDeskControl;
      if (control?.dataChannel !== this.channel) return;
      // Numeric control actions share the negotiated input epoch sequence.
      control.send({ type: 3, host_info: { host_name: "Web 浏览器", display_num: 0,
        displays: [], supports_file_browser: !!this.local?.handle, platform: "unknown" } });
    }
    selectLocal(local) {
      if (this.closed) return;
      this.local = local;
      this.snapshots.clear();
      this.advertise();
      this.notify();
    }
    async serve(message) {
      if (this.closed) return;
      let result;
      try {
        if (!this.opened) throw failure("browser_not_open");
        if (message.op === "prepare") {
          const context = this.destinations.get(message.transfer_id) ||
            [...this.destinations.values()].find(value => value.path === message.destination);
          const local = context?.local || this.local;
          const path = text(message.destination);
          if (!context && (!local || !local.handle)) throw failure("choose_directory");
          if (context && context.path !== path) throw failure("invalid_path");
          const items = message.items;
          if (!Array.isArray(items) || !items.length || items.length > 64 || this.reservations.size + items.length > 8192) throw failure("invalid_request");
          const ids = new Set();
          for (const item of items) {
            if (!Number.isInteger(item.file_id) || item.file_id < 0 || item.file_id > 0xffffffff || (item.file_id && (ids.has(item.file_id) || this.reservations.has(item.file_id) || this.files.incoming.has(item.file_id) || this.files.finished.has(item.file_id)))) throw failure("invalid_request");
            if (item.file_id) ids.add(item.file_id);
            components(item.directory);
            if (!local?.handle && (!item.file_id || item.directory)) throw failure("folder_download");
          }
          const root = local?.handle ? await local.directory(path) : null;
          for (const item of items) {
            if (this.closed) throw failure("disconnected");
            let directory = root;
            for (const part of components(item.directory)) directory = await directory.getDirectoryHandle(part, { create: true });
            if (item.file_id) this.reservations.set(item.file_id, { directory, local, path, context });
          }
          result = { ok: true };
          window.CrossDeskFileManager?.received(this);
        } else if (message.op === "list") {
          if (!this.local) throw failure("choose_directory");
          for (const [key, value] of this.snapshots) if (Date.now() > value.expires) this.snapshots.delete(key);
          let snapshot, token, offset = 0;
          if (message.cursor) {
            const match = /^(\d+):(\d+)$/.exec(text(message.cursor));
            if (!match) throw failure("invalid_listing");
            token = match[1]; offset = Number(match[2]); snapshot = this.snapshots.get(token);
            if (!snapshot) throw failure("listing_expired");
          } else {
            token = String(++this.sequence);
            const listing = message.path === "@roots" ? { path: "@roots", parent: "", entries: [
              { name: this.local.name, path: this.local.base, directory: true, size: 0, modified: "", link: false }
            ] } : await this.local.list(text(message.path) || this.local.base, () => !this.closed);
            snapshot = { ...listing, expires: Date.now() + 30000 };
          }
          if (offset > snapshot.entries.length) throw failure("invalid_listing");
          let bytes = 0, next = offset;
          const entries = [];
          while (next < snapshot.entries.length && entries.length < 512) {
            const entry = snapshot.entries[next], size = encoder.encode(JSON.stringify(entry)).length + 1;
            if (size > 45000) throw failure("invalid_listing");
            if (bytes + size > 45000) break;
            bytes += size; entries.push(entry); next++;
          }
          const truncated = next < snapshot.entries.length, cursor = truncated && message.pagination === 1 ? `${token}:${next}` : "";
          if (cursor) {
            if (this.snapshots.size >= 16 && !this.snapshots.has(token)) throw failure("busy");
            snapshot.expires = Date.now() + 30000; this.snapshots.set(token, snapshot);
          } else this.snapshots.delete(token);
          result = { ok: true, path: snapshot.path, parent: snapshot.parent, entries, offset,
            total: snapshot.entries.length, truncated, next: cursor };
        } else if (message.op === "list_cancel") {
          this.snapshots.delete(text(message.cursor).split(":")[0]); result = { ok: true };
        } else if (message.op === "copy") {
          if (!this.local) throw failure("choose_directory");
          // Do not hold the service queue while awaiting prepare replies.
          const work = this.upload(message.paths, text(message.destination), this.local);
          void work.then(() => this.notice(message, { ok: true, message: "queued" }),
            error => this.notice(message, { ok: false, error: error.code || "file_unreadable" }));
          result = { ok: true, message: "queued" };
        } else if (message.op === "cancel") {
          const item = this.files.items.find(item => item.direction === "send" && item.id === message.file_id);
          if (!item) throw failure("already_finished");
          this.files.cancel(item); result = { ok: true };
        } else throw failure("unsupported");
      } catch (error) { result = { ok: false, error: error.code || (error.name === "NotAllowedError" ? "directory_not_writable" : "directory_unavailable") }; }
      if (!this.closed) this.send({ ...result, op: "reply", id: message.id, ...(message.transfer_id ? { transfer_id: message.transfer_id } : {}) });
    }
    notice(message, result) {
      if (!this.closed) this.send({ ...result, op: "notice", id: ++this.sequence, transfer_id: message.transfer_id || "" });
    }
    async upload(paths, destination, local = this.local) {
      if (!this.ready) throw failure("disconnected");
      if (this.uploading) throw failure("busy");
      if (!local) throw failure("choose_directory");
      if (!Array.isArray(paths) || paths.some(path => typeof path !== "string")) throw failure("invalid_request");
      this.uploading = true; this.notify();
      try {
        const items = await local.collect(paths, () => !this.closed);
        if (this.closed) throw failure("disconnected");
        const files = items.filter(item => item.file);
        this.files.validate(files.map(item => item.file));
        if (this.supported && !destination) throw failure("invalid_path");
        for (const item of files) item.id = this.files.allocateId();
        if (!this.supported) {
          if (items.some(item => !item.file)) throw failure("unsupported");
          this.files.enqueue(files.map(item => item.file), files.map(item => item.id));
          return;
        }
        for (let start = 0; start < items.length;) {
          const batch = []; let size = encoder.encode(destination).length;
          while (start < items.length && batch.length < 32) {
            const item = items[start], bytes = encoder.encode(JSON.stringify({ file_id: item.id, directory: item.directory })).length;
            if (batch.length && size + bytes > 44000) break;
            size += bytes; batch.push(item); start++;
          }
          await this.request({ op: "prepare", destination, items: batch.map(item => ({ file_id: item.id, directory: item.directory })) });
          if (this.closed) throw failure("disconnected");
          const send = batch.filter(item => item.file);
          if (send.length) this.files.enqueue(send.map(item => item.file), send.map(item => item.id));
        }
        this.feedback("已加入传输队列 · 同名文件自动另存");
        window.CrossDeskFileManager?.sent(this);
      } finally { this.uploading = false; this.notify(); }
    }
    async download(entries, destination) {
      if (!this.ready || !this.supported) throw failure("unsupported");
      if (!entries.length || entries.length > MAX_SELECTION) throw failure("too_many_selected");
      if (entries.some(entry => entry.link)) throw failure("symbolic_link");
      const local = this.local?.handle ? this.local : null;
      if (!local && entries.some(entry => entry.directory)) throw failure("folder_download");
      if (!local && !this.files.canWriteFiles) throw failure("directory_not_writable");
      // A unique destination also correlates replies from clients predating transfer_id.
      const id = crypto.randomUUID(), path = local ? destination : `/downloads/${id}`;
      if (local) await local.directory(path);
      for (const [key, value] of this.destinations) if (value.finished && ![...this.reservations.values()].some(r => r.context === value)) this.destinations.delete(key);
      if (this.destinations.size >= 128) throw failure("busy");
      const context = { path, local, finished: false };
      this.destinations.set(id, context);
      try {
        await this.request({ op: "copy", paths: entries.map(entry => entry.path), destination: path, transfer_id: id });
        this.feedback(local ? "已请求远端发送 · 文件将保存到本机当前目录" : "已请求远端发送 · 文件将保存到浏览器下载目录");
      } catch (error) { this.destinations.delete(id); throw error; }
    }
    forgetReservation(id) { this.reservations.delete(id); }
    async openTarget(item) {
      const reservation = this.reservations.get(item.id);
      if (!reservation) return false;
      this.reservations.delete(item.id);
      if (!reservation.directory) return false;
      const dir = reservation.directory;
      let name = item.name, handle;
      const dot = name.lastIndexOf("."), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
      for (let suffix = 0; ; suffix++) {
        if (this.closed || !this.files.receiving(item)) throw failure("disconnected");
        name = suffix ? `${stem} (${suffix})${ext}` : item.name;
        try { await dir.getFileHandle(name); }
        catch (error) {
          if (error.name === "NotFoundError") { handle = await dir.getFileHandle(name, { create: true }); break; }
          if (error.name !== "TypeMismatchError") throw error;
        }
        if (suffix >= 10000) throw failure("directory_not_writable");
      }
      let stream;
      try { stream = await handle.createWritable(); }
      catch (error) { await dir.removeEntry(name).catch(() => {}); throw error; }
      let settled = false;
      item.writer = {
        write: bytes => stream.write(bytes),
        close: async () => { await stream.close(); settled = true; },
        abort: async () => {
          if (settled) return;
          settled = true;
          await stream.abort().catch(() => {});
          await dir.removeEntry(name).catch(() => {});
        }
      };
      item.savedToDirectory = true;
      if (!this.files.receiving(item)) { await item.writer.abort(); throw failure("disconnected"); }
      return true;
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(failure("disconnected")); }
      this.pending.clear(); this.snapshots.clear(); this.reservations.clear(); this.destinations.clear();
      this.local = null;
      this.notify();
    }
  }
  window.CrossDeskLocalDirectory = LocalDirectory;
  window.CrossDeskFileBrowserSession = FileBrowserSession;
  window.CrossDeskFileBrowser = { join, failure };
})();
