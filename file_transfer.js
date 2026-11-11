// CrossDesk's packed little-endian FileChunkHeader / FileTransferAck protocol.
// Keep wire constants aligned with libs/wire/include/file_transfer_format.h.
(function () {
  "use strict";
  const CHUNK_MAGIC = 0x4a4e544d, ACK_MAGIC = 0x4a4e5443;
  const HEADER_SIZE = 31, ACK_SIZE = 28, CHUNK_SIZE = 16 * 1024;
  const TIMEOUT = 30000, BUFFER_LIMIT = 256 * 1024, WINDOW_SIZE = 1024 * 1024;
  const MAX_ITEMS = 4096, RECEIVE_QUEUE_LIMIT = 8 * 1024 * 1024;
  const active = item => ["queued", "sending", "receiving", "saving"].includes(item.status);
  const safeName = name => name.replace(/\\/g, "/").split("/").pop()
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").replace(/[. ]+$/g, "") || "download";
  const uint64 = (view, offset) => {
    const value = view.getBigUint64(offset, true);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : NaN;
  };
  const storageError = error => error?.name === "NotSupportedError"
    ? "当前页面无法流式下载，请使用支持 Service Worker 的浏览器，通过 HTTPS 或 localhost 打开。"
    : "浏览器下载已中断，请检查下载权限、存储空间后重新发送。";

  class FileTransferSession {
    constructor(peer) {
      this.peer = peer;
      this.channels = {};
      this.items = [];
      this.incoming = new Map();
      this.finished = new Map();
      this.outgoing = null;
      this.nextId = Math.floor(Math.random() * 0xffffffff);
      this.receiveQueue = [];
      this.queuedBytes = 0;
      this.draining = false;
      this.releasing = new Set();
      this.closed = false;
      this.state = "waiting";
      this.error = "";
      this.timer = null;
      this.notification = null;
      this.probeTimer = null;
      this.pending = [];
      this.pendingBytes = 0;
      this.browser = window.CrossDeskFileBrowserSession ? new window.CrossDeskFileBrowserSession(this) : null;
      this.notify(true);
    }

    get ready() {
      return !this.closed && ["file", "file_feedback"].every(label =>
        this.channels[label]?.readyState === "open");
    }

    get canWriteFiles() {
      return window.CrossDeskDownloadWriter?.supported === true;
    }

    async openTarget(item) {
      if (await this.browser?.openTarget(item)) return;
      if (!this.receiving(item)) throw new Error("Transfer ended");
      if (!this.canWriteFiles) throw new DOMException("Streaming download unavailable", "NotSupportedError");
      item.writer = new window.CrossDeskDownloadWriter(item.name, item.total, message => {
        if (this.receiving(item)) this.finishReceive(item, "failed", message);
      });
      await item.writer.open();
    }

    receiving(item) {
      return !this.closed && this.incoming.get(item.id) === item &&
        ["receiving", "saving"].includes(item.status);
    }

    notify(immediate = false) {
      if (!immediate) {
        if (!this.notification) this.notification = setTimeout(() => this.notify(true), 100);
        return;
      }
      clearTimeout(this.notification);
      this.notification = null;
      // Bound finished history in both directions without limiting active transfers.
      const terminal = this.items.filter(item => !active(item));
      const retained = new Set(terminal.slice(-100));
      this.items = this.items.filter(item => active(item) || retained.has(item));
      if (!this.closed || !window.CrossDeskFiles || window.CrossDeskFiles === this) {
        window.CrossDeskFiles = this;
        window.CrossDeskSessionControls?.renderFiles(this);
        this.browser?.notify();
      }
    }

    probe() {
      if (this.closed || this.ready) return;
      clearTimeout(this.probeTimer);
      this.probeTimer = setTimeout(() => {
        if (!this.closed && !this.ready) {
          this.state = "unsupported";
          this.notify(true);
        }
      }, 8000);
    }

    attach(channel) {
      const label = channel.label;
      if (!["file", "file_feedback"].includes(label)) return false;
      if (this.closed || this.channels[label] || channel.protocol !== "crossdesk-file-v1" ||
          !channel.ordered || channel.maxRetransmits != null || channel.maxPacketLifeTime != null) {
        channel.close();
        return true;
      }
      this.channels[label] = channel;
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = BUFFER_LIMIT / 2;
      channel.addEventListener("bufferedamountlow", () => void this.pump());
      const opened = () => {
        if (!this.ready) return;
        clearTimeout(this.probeTimer);
        this.state = "ready";
        if (!this.timer) this.timer = setInterval(() => this.tick(), 250);
        const pending = this.pending;
        this.pending = [];
        this.pendingBytes = 0;
        for (const [label, data] of pending) this.receive(label, data);
        this.notify(true);
      };
      channel.addEventListener("open", opened);
      channel.addEventListener("close", () => this.close("文件通道已断开，请重新连接。"));
      channel.addEventListener("error", () => this.close("文件通道发生错误，请重新连接。"));
      channel.addEventListener("message", ({ data }) => {
        if (this.closed || !(data instanceof ArrayBuffer)) return;
        // A file can arrive before the feedback channel's open event.
        if (!this.ready) {
          this.pendingBytes += data.byteLength;
          if (this.pendingBytes > WINDOW_SIZE + BUFFER_LIMIT || this.pending.length >= 128)
            this.close("文件通道尚未就绪，请重新连接。");
          else this.pending.push([label, data]);
          return;
        }
        this.receive(label, data);
      });
      opened();
      return true;
    }

    receive(label, data) {
      if (!this.ready) return;
      try {
        if (label === "file_feedback") this.receiveAck(data);
        else {
          // Include the in-flight write in the budget; never accumulate the
          // whole file or an unbounded promise chain when the disk is slow.
          if (this.queuedBytes + data.byteLength > RECEIVE_QUEUE_LIMIT || this.receiveQueue.length >= 512) {
            this.close("接收队列已满，请检查本地存储速度后重试。");
            return;
          }
          this.receiveQueue.push(data);
          this.queuedBytes += data.byteLength;
          void this.drainReceiveQueue();
        }
      } catch (err) {
        this.close("文件处理失败，请重新连接后重试。");
      }
    }

    async drainReceiveQueue() {
      if (this.draining) return;
      this.draining = true;
      try {
        while (this.ready && this.receiveQueue.length) {
          const data = this.receiveQueue.shift();
          try { await this.receiveChunk(data); }
          finally { this.queuedBytes -= data.byteLength; }
        }
      } catch (error) {
        this.close("文件处理失败，请重新连接后重试。");
      } finally {
        this.draining = false;
      }
    }

    allocateId() {
      do { this.nextId = (this.nextId + 1) >>> 0 || 1; }
      while (this.items.some(item => item.direction === "send" && item.id === this.nextId));
      return this.nextId;
    }

    validate(files) {
      if (!this.ready) throw new Error("文件通道尚未就绪，请稍后重试。");
      if (this.items.filter(active).length + files.length > MAX_ITEMS)
        throw new Error("传输队列已满，请等待当前任务完成后再发送。");
      const maxMessage = this.peer.sctp?.maxMessageSize || Infinity;
      for (const file of files) {
        const name = new TextEncoder().encode(file.name);
        if (!name.length || name.length > 65535 || HEADER_SIZE + name.length >= maxMessage ||
            !Number.isSafeInteger(file.size) || file.size < 0)
          throw new Error("文件名过长或文件大小无效，请重新选择。");
      }
    }

    enqueue(files, ids = []) {
      this.validate(files);
      this.error = "";
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        this.items.push({ id: ids[index] || this.allocateId(), direction: "send", name: file.name,
          total: file.size, bytes: 0, sent: 0, last: false, status: "queued", file,
          wireName: new TextEncoder().encode(file.name), updated: Date.now(), detail: "" });
      }
      this.startNext();
      this.notify(true);
    }

    startNext() {
      if (!this.ready || this.outgoing) return;
      const item = this.items.find(item => item.status === "queued");
      if (!item) return;
      this.outgoing = item;
      item.status = "sending";
      item.updated = Date.now();
      void this.pump();
    }

    async pump() {
      const item = this.outgoing, channel = this.channels.file;
      if (!this.ready || !item || item.pumping || item.last) return;
      item.pumping = true;
      try {
        while (this.ready && this.outgoing === item && !item.last &&
               channel.bufferedAmount < BUFFER_LIMIT && item.sent - item.bytes < WINDOW_SIZE) {
          const first = item.sent === 0;
          const name = first ? item.wireName : new Uint8Array();
          const overhead = HEADER_SIZE + name.length;
          const capacity = Math.min(CHUNK_SIZE, (this.peer.sctp?.maxMessageSize || Infinity) - overhead);
          if (capacity <= 0) throw new Error("Message size too small");
          const size = Math.min(capacity, item.total - item.sent);
          const payload = await item.file.slice(item.sent, item.sent + size).arrayBuffer();
          if (!this.ready || this.outgoing !== item) return;
          if (payload.byteLength !== size) throw new Error("Short file read");
          const last = item.sent + size === item.total;
          const packet = new ArrayBuffer(overhead + size), view = new DataView(packet);
          view.setUint32(0, CHUNK_MAGIC, true);
          view.setUint32(4, item.id, true);
          view.setBigUint64(8, BigInt(item.sent), true);
          view.setBigUint64(16, BigInt(item.total), true);
          view.setUint32(24, size, true);
          view.setUint16(28, name.length, true);
          view.setUint8(30, (first ? 1 : 0) | (last ? 2 : 0));
          new Uint8Array(packet, HEADER_SIZE, name.length).set(name);
          new Uint8Array(packet, overhead).set(new Uint8Array(payload));
          item.sent += size;
          item.last = last;
          channel.send(packet);
        }
      } catch (err) {
        if (this.outgoing === item) this.finishSend(item, "failed", "读取或发送失败，请重新选择文件。");
      } finally {
        item.pumping = false;
      }
    }

    receiveAck(data) {
      if (data.byteLength !== ACK_SIZE) return;
      const view = new DataView(data), item = this.outgoing;
      if (view.getUint32(0, true) !== ACK_MAGIC || !item || view.getUint32(4, true) !== item.id) return;
      const bytes = uint64(view, 8), total = uint64(view, 16), flags = view.getUint32(24, true);
      if (!Number.isFinite(bytes) || total !== item.total || bytes > item.sent || flags > 3) return;
      if (flags & 2) {
        this.finishSend(item, "failed", "远端取消或无法保存文件。");
      } else if (flags & 1) {
        if (item.last && bytes === item.total) {
          item.bytes = bytes;
          this.finishSend(item, "completed");
        }
      } else if (bytes > item.bytes) {
        item.bytes = bytes;
        item.updated = Date.now();
        this.notify();
        void this.pump();
      }
    }

    sendCancel(item) {
      if (!this.ready) return;
      const packet = new ArrayBuffer(HEADER_SIZE), view = new DataView(packet);
      view.setUint32(0, CHUNK_MAGIC, true);
      view.setUint32(4, item.id, true);
      view.setBigUint64(16, BigInt(item.total), true);
      view.setUint8(30, 4);
      try { this.channels.file.send(packet); } catch (err) {}
    }

    finishSend(item, status, detail = "") {
      if (status !== "completed") this.sendCancel(item);
      item.status = status;
      item.detail = detail;
      item.file = null;
      item.wireName = null;
      if (status === "completed") window.CrossDeskFileManager?.sent(this.browser);
      if (this.outgoing === item) this.outgoing = null;
      this.notify(true);
      this.startNext();
    }

    ack(id, bytes, total, flags) {
      if (!this.ready) return;
      const channel = this.channels.file_feedback;
      if (channel.bufferedAmount > BUFFER_LIMIT) {
        this.close("文件确认通道拥塞，请重新连接。");
        return;
      }
      const packet = new ArrayBuffer(ACK_SIZE), view = new DataView(packet);
      view.setUint32(0, ACK_MAGIC, true);
      view.setUint32(4, id, true);
      view.setBigUint64(8, BigInt(bytes), true);
      view.setBigUint64(16, BigInt(total), true);
      view.setUint32(24, flags, true);
      try { channel.send(packet); }
      catch (err) { this.close("文件确认发送失败，请重新连接。"); }
    }

    receiveChunk(data) {
      if (data.byteLength < HEADER_SIZE) return;
      const view = new DataView(data);
      if (view.getUint32(0, true) !== CHUNK_MAGIC) return;
      const id = view.getUint32(4, true), offset = uint64(view, 8), total = uint64(view, 16);
      const size = view.getUint32(24, true), nameSize = view.getUint16(28, true), flags = view.getUint8(30);
      if (!Number.isFinite(total)) return;
      let item = this.incoming.get(id);
      const previous = this.finished.get(id);
      if (previous) {
        this.ack(id, previous.total === total ? previous.bytes : 0, total,
          previous.total === total ? previous.flags : 2);
        return;
      }
      const reject = detail => {
        this.browser?.forgetReservation(id);
        if (item) this.finishReceive(item, "failed", detail);
        else {
          this.remember(id, total, 0, 2);
          this.error = detail;
          this.notify(true);
          this.ack(id, 0, total, 2);
        }
      };
      if (flags === 4 && data.byteLength === HEADER_SIZE && offset === 0 && !size && !nameSize &&
          (!item || item.total === total)) {
        this.browser?.forgetReservation(id);
        if (item) this.finishReceive(item, "cancelled", "远端已取消。");
        else { this.remember(id, total, 0, 2); this.ack(id, 0, total, 2); }
        return;
      }
      const first = !!(flags & 1), last = !!(flags & 2);
      if (!Number.isFinite(offset) || flags > 3 || size > 65536 ||
          data.byteLength !== HEADER_SIZE + nameSize + size || offset + size > total ||
          (!size && !last) || last !== (offset + size === total) ||
          (first ? offset !== 0 || !nameSize || !!item : !!nameSize || !item) ||
          (item && (item.total !== total || item.bytes !== offset))) {
        reject("收到无效的文件数据，传输已停止。");
        return;
      }
      if (!item) {
        if (this.incoming.size >= 4) {
          reject("接收任务或记录过多，请移除已结束的记录后重试。");
          return;
        }
        let name;
        try { name = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(data, HEADER_SIZE, nameSize)); }
        catch (err) { reject("文件名编码无效，无法接收。"); return; }
        item = { id, direction: "receive", name: safeName(name), total, bytes: 0,
          status: "receiving", updated: Date.now(), detail: "" };
        this.incoming.set(id, item);
        this.items.push(item);
        this.notify(true);
      }
      item.operation = this.writeChunk(item, new Uint8Array(data, HEADER_SIZE + nameSize), last);
      return item.operation;
    }

    async writeChunk(item, payload, last) {
      try {
        if (!item.writer) await this.openTarget(item);
        if (!this.receiving(item)) return;
        if (payload.length) await item.writer.write(payload);
        if (!this.receiving(item)) return;
        item.bytes += payload.length;
        item.updated = Date.now();
        if (last) {
          item.status = "saving";
          this.notify(true);
          await item.writer.close();
          item.writer = null;
          if (!this.receiving(item)) return;
          item.detail = item.savedToDirectory ? "已保存到本机目录。" : "已传至浏览器下载，请在下载列表中查看保存结果。";
          item.status = "completed";
          this.incoming.delete(item.id);
          this.remember(item.id, item.total, item.total, 1);
          this.ack(item.id, item.total, item.total, 1);
          window.CrossDeskFileManager?.received(this.browser);
          this.notify(true);
        } else {
          this.ack(item.id, item.bytes, item.total, 0);
          this.notify();
        }
      } catch (error) {
        if (this.receiving(item)) this.finishReceive(item, "failed", storageError(error));
      }
    }

    remember(id, total, bytes, flags) {
      this.finished.set(id, { total, bytes, flags, at: Date.now() });
      if (this.finished.size > 1024) this.finished.delete(this.finished.keys().next().value);
    }

    release(item) {
      if (item.direction !== "receive") return Promise.resolve();
      if (item.cleanup) return item.cleanup;
      // The download writer can abort an outstanding port request immediately.
      const abort = Promise.resolve(item.writer?.abort()).catch(() => {});
      item.cleanup = Promise.all([abort, Promise.resolve(item.operation).catch(() => {})]).then(() => { item.writer = null; });
      this.releasing.add(item.cleanup);
      item.cleanup.then(() => this.releasing.delete(item.cleanup));
      return item.cleanup;
    }

    finishReceive(item, status, detail) {
      item.status = status;
      item.detail = detail;
      this.release(item);
      this.incoming.delete(item.id);
      this.remember(item.id, item.total, item.bytes, 2);
      this.ack(item.id, item.bytes, item.total, 2);
      this.notify(true);
    }

    cancel(item) {
      if (!this.items.includes(item) || !active(item)) return;
      if (item.direction === "receive") this.finishReceive(item, "cancelled", "已取消接收。");
      else if (item === this.outgoing) this.finishSend(item, "cancelled");
      else { this.sendCancel(item); item.status = "cancelled"; item.file = null; item.wireName = null; this.notify(true); }
    }

    remove(item) {
      if (active(item)) return;
      this.release(item);
      this.items = this.items.filter(candidate => candidate !== item);
      this.notify(true);
    }

    tick() {
      const now = Date.now();
      for (const [id, entry] of this.finished) if (now - entry.at > TIMEOUT * 2) this.finished.delete(id);
      if (this.outgoing && now - this.outgoing.updated > TIMEOUT)
        this.finishSend(this.outgoing, "failed", "等待远端确认超时，请重试。");
      for (const item of this.incoming.values()) if (now - item.updated > TIMEOUT)
        this.finishReceive(item, "failed", "接收超时，请让远端重新发送。");
      void this.pump();
    }

    close(reason = "连接已结束。") {
      if (this.closed) return;
      this.closed = true;
      this.browser?.close();
      this.state = "closed";
      this.error = reason;
      clearInterval(this.timer);
      clearTimeout(this.probeTimer);
      for (const item of this.items) {
        if (active(item)) { item.status = "failed"; item.detail = reason; }
        item.file = null;
        item.wireName = null;
        this.release(item);
      }
      this.incoming.clear();
      this.finished.clear();
      this.pending = [];
      this.pendingBytes = 0;
      this.queuedBytes -= this.receiveQueue.reduce((bytes, data) => bytes + data.byteLength, 0);
      this.receiveQueue = [];
      this.outgoing = null;
      for (const channel of Object.values(this.channels)) channel.close();
      this.cleanup = Promise.all([...this.releasing]);
      this.notify(true);
    }
  }
  window.CrossDeskFileTransferSession = FileTransferSession;
  window.addEventListener("pagehide", () => window.CrossDeskFiles?.close());
})();
