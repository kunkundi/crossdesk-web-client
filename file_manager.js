// Compact dual-pane file manager. Transfer state belongs to the session, not the dialog.
(function () {
  "use strict";
  const icons = {
    up: '<path d="m5 10 7-7 7 7M12 3v18"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
    folder: '<path d="M3 7V5h6l2 2h10v13H3Z"/>',
    file: '<path d="M14 3H5v18h14V8Zm0 0v5h5"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
  const button = (action, title, glyph) => `<button type="button" data-action="${action}" title="${title}" aria-label="${title}" class="fm-icon">${icon(glyph)}</button>`;
  const format = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB`
    : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  const labels = { queued: "排队中", sending: "发送中", completed: "已完成", failed: "失败", cancelled: "已取消" };
  const running = item => ["queued", "sending"].includes(item.status);
  const el = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const paneHTML = (side, title) => `<section class="fm-pane" data-side="${side}" aria-label="${title}文件目录">
    <div class="fm-pane-heading"><strong>${title}</strong><span class="fm-location"></span><label class="fm-search">${icon("search")}<input type="search" placeholder="筛选名称" aria-label="筛选${title}文件"></label></div>
    <div class="fm-pathbar">${button("up", "上级目录", "up")}<input class="fm-path" aria-label="${title}路径" spellcheck="false">${button("tree", "浏览目录", "folder")}</div>
    <div class="fm-columns" role="row"><label class="fm-check"><input type="checkbox" aria-label="全选${title}文件"></label><button type="button" data-sort="name">名称 <span></span></button><button type="button" data-sort="modified">修改日期 <span></span></button><button type="button" data-sort="size">大小 <span></span></button></div>
    <div class="fm-viewport" tabindex="0" role="grid" aria-label="${title}文件列表" aria-multiselectable="true"><div class="fm-rows"></div></div>
    <div class="fm-pane-status" role="status"></div><div class="fm-pane-empty" hidden></div>
    <div class="fm-pane-footer"><span class="fm-count">0 项</span><select class="fm-sort-select" aria-label="${title}排序"><option value="name:asc">名称↑</option><option value="name:desc">名称↓</option><option value="modified:desc">日期↓</option><option value="modified:asc">日期↑</option><option value="size:desc">大小↓</option><option value="size:asc">大小↑</option></select><label><input type="checkbox" class="fm-hidden">隐藏文件</label></div>
    <div class="fm-tree" hidden></div>
  </section>`;

  class FileManager {
    constructor() {
      this.dialog = document.createElement("dialog");
      this.dialog.id = "file-manager";
      this.dialog.tabIndex = -1;
      this.dialog.setAttribute("aria-labelledby", "fm-title");
      this.dialog.innerHTML = `<header class="fm-titlebar"><h2 id="fm-title">文件传输</h2><span class="fm-peer"></span><button type="button" data-action="refresh" class="fm-refresh">${icon("refresh")}刷新目录</button>${button("close", "关闭文件传输", "close")}</header>
        <div class="fm-body"><div class="fm-panes">${paneHTML("local", "本机")}${paneHTML("remote", "远端")}</div>
        <footer class="fm-transfer"><div class="fm-actions"><div class="fm-guidance"><span class="fm-hint">双击打开目录，拖到另一侧发送</span><span class="fm-feedback" role="status" aria-live="polite"></span></div><button type="button" class="fm-send" disabled>发送到远端</button></div>
        <div class="fm-tasks-heading"><button type="button" class="fm-tasks-toggle" aria-expanded="false">传输任务 · 暂无任务</button><button type="button" class="fm-clear" disabled>清除已完成</button></div><div class="fm-tasks" hidden></div></footer></div>
        <div class="fm-context" role="menu" hidden><button type="button" role="menuitem">打开目录</button></div><input class="fm-file-picker" type="file" multiple hidden><input class="fm-folder-picker" type="file" webkitdirectory multiple hidden>`;
      document.body.append(this.dialog);
      this.panes = {};
      for (const side of ["local", "remote"]) {
        const node = this.dialog.querySelector(`[data-side="${side}"]`);
        this.panes[side] = { side, node, path: "", parent: "", entries: [], visible: [], selected: new Set(),
          sort: "name", descending: false, hidden: false, query: "", ticket: 0, busy: false, anchor: -1,
          viewport: node.querySelector(".fm-viewport"), rows: node.querySelector(".fm-rows"), loaded: false };
        this.bindPane(this.panes[side]);
      }
      this.source = "local";
      this.bind();
    }
    query(selector) { return this.dialog.querySelector(selector); }
    bind() {
      this.query('[data-action="close"]').onclick = () => this.hide();
      this.query('[data-action="refresh"]').onclick = () => this.refresh();
      this.query(".fm-send").onclick = () => void this.send();
      this.query(".fm-clear").onclick = () => {
        for (const item of [...(this.browser?.files.items || [])]) if (!running(item)) this.browser.files.remove(item);
      };
      this.query(".fm-tasks-toggle").onclick = () => {
        this.expanded = !this.expanded; this.renderTasks();
      };
      this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.hide(); });
      this.dialog.addEventListener("close", () => { this.drag = null; this.dismissMenus(); });
      this.dialog.addEventListener("pointerdown", event => {
        if (!event.target.closest(".fm-tree, [data-action=tree]")) this.dismissTrees();
        if (!event.target.closest(".fm-context")) this.query(".fm-context").hidden = true;
      });
      this.dialog.addEventListener("keydown", event => {
        if (event.key === "Escape" && (this.drag || !this.query(".fm-context").hidden || [...Object.values(this.panes)].some(p => !p.node.querySelector(".fm-tree").hidden))) {
          event.preventDefault(); event.stopPropagation(); this.clearDrag(); this.dismissMenus();
        }
      });
      for (const selector of [".fm-file-picker", ".fm-folder-picker"]) this.query(selector).onchange = event => {
        if (this.pickerSession === this.browser && !this.browser?.closed && event.target.files.length) {
          this.browser.selectLocal(new window.CrossDeskLocalDirectory(null, Array.from(event.target.files)));
          void this.load(this.panes.local, this.browser.local.base);
        }
        event.target.value = ""; this.pickerSession = null;
      };
      this.resizeObserver = new ResizeObserver(() => { for (const pane of Object.values(this.panes)) this.paint(pane); });
      for (const pane of Object.values(this.panes)) this.resizeObserver.observe(pane.viewport);
    }
    open(files = window.CrossDeskFiles) {
      if (!files?.browser || files.closed) return;
      const browser = files.browser;
      if (this.browser !== browser) {
        this.hide(); this.browser = browser; this.expanded = false; this.source = "local";
        for (const pane of Object.values(this.panes)) {
          Object.assign(pane, { path: "", parent: "", entries: [], visible: [], loaded: false, busy: false, error: "", query: "", ticket: pane.ticket + 1 });
          pane.selected.clear(); pane.node.querySelector("input[type=search]").value = "";
          pane.node.querySelector(".fm-path").value = "";
        }
        this.query(".fm-feedback").textContent = "";
      }
      browser.opened = true;
      this.preparing = false;
      window.CrossDeskControl?.cancelLocalInput();
      window.CrossDeskControl?.hideVirtualKeyboard();
      if (document.pointerLockElement) document.exitPointerLock?.();
      if (!this.dialog.open) this.dialog.showModal();
      this.dialog.focus({ preventScroll: true });
      if (browser.local) void this.load(this.panes.local, this.panes.local.path || browser.local.base);
      if (browser.supported && browser.ready) void this.load(this.panes.remote, this.panes.remote.path);
      this.update(browser);
    }
    hide() {
      if (this.dialog.open) this.dialog.close();
      this.clearDrag(); this.dismissMenus();
      for (const pane of Object.values(this.panes)) { ++pane.ticket; pane.busy = false; clearTimeout(pane.transferTimer); pane.refreshPending = false; }
    }
    update(browser) {
      if (this.browser !== browser) return;
      if (browser.closed) { this.hide(); this.preparing = false; return; }
      this.query(".fm-peer").textContent = browser.name === "远端" ? "" : browser.name;
      this.panes.remote.node.querySelector(".fm-location").textContent = "";
      this.panes.local.node.querySelector(".fm-location").textContent = browser.local?.name || "";
      if (this.dialog.open && browser.ready && browser.supported && !this.panes.remote.loaded && !this.panes.remote.busy)
        void this.load(this.panes.remote, "");
      for (const pane of Object.values(this.panes)) this.renderPane(pane);
      this.renderTasks(); this.renderActions();
    }
    feedback(browser, message, error = false) {
      if (browser !== this.browser) return;
      clearTimeout(this.feedbackTimer);
      const node = this.query(".fm-feedback"); node.textContent = message; node.classList.toggle("fm-error", error);
      if (!error) this.feedbackTimer = setTimeout(() => { node.textContent = ""; }, 3500);
    }
    report(error) { if (error?.name !== "AbortError") this.feedback(this.browser, error.message || "操作失败，请重试。", true); }
    async choose(folder = true) {
      const browser = this.browser;
      if (!browser || browser.closed) return;
      if (folder && typeof window.showDirectoryPicker === "function") {
        try {
          const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "crossdesk-files" });
          if (this.browser !== browser || browser.closed) return;
          browser.selectLocal(new window.CrossDeskLocalDirectory(handle));
          await this.load(this.panes.local, browser.local.base);
        } catch (error) { if (this.browser === browser) this.report(error); }
      } else {
        this.pickerSession = browser;
        this.query(folder ? ".fm-folder-picker" : ".fm-file-picker").click();
      }
    }
    async load(pane, path, preserve = false) {
      const browser = this.browser;
      if (!browser || browser.closed || (pane.side === "remote" && (!browser.supported || !browser.ready))) return;
      const ticket = ++pane.ticket;
      const current = () => this.browser === browser && !browser.closed && pane.ticket === ticket;
      pane.busy = true; pane.error = ""; pane.progress = "正在读取目录…";
      this.clearDrag(); this.dismissTrees(); this.renderPane(pane); this.renderActions();
      try {
        const result = pane.side === "local" ? await browser.local.list(path, current)
          : await browser.listRemote(path, current, (count, total) => {
            if (current()) { pane.progress = `正在读取 ${count}${total ? ` / ${total}` : ""} 项…`; this.renderPane(pane); }
          });
        if (!current()) return;
        pane.entries = result.entries.map(entry => ({ ...entry, path: entry.path || window.CrossDeskFileBrowser.join(result.path, entry.name) }));
        pane.path = result.path; pane.parent = result.parent; pane.loaded = true;
        const paths = new Set(pane.entries.map(entry => entry.path));
        pane.selected = preserve ? new Set([...pane.selected].filter(path => paths.has(path))) : new Set();
        pane.node.querySelector(".fm-path").value = pane.side === "local" ? browser.local.display(pane.path) : pane.path;
        this.filter(pane); pane.viewport.scrollTop = 0;
      } catch (error) {
        if (current()) { pane.error = error.message; pane.loaded = true; }
      } finally {
        if (current()) {
          pane.busy = false; this.renderPane(pane); this.renderActions();
          if (pane.refreshPending) { pane.refreshPending = false; this.refreshAfterTransfer(browser, pane.side); }
        }
      }
    }
    refresh() {
      for (const pane of Object.values(this.panes)) {
        if (pane.side === "local" && !this.browser?.local) continue;
        void this.load(pane, pane.path, true);
      }
    }
    sent(browser) { this.refreshAfterTransfer(browser, "remote"); }
    received(browser) { this.refreshAfterTransfer(browser, "local"); }
    refreshAfterTransfer(browser, side) {
      if (browser !== this.browser) return;
      const pane = this.panes[side];
      clearTimeout(pane.transferTimer);
      pane.transferTimer = setTimeout(() => {
        if (!this.dialog.open || this.browser !== browser || browser.closed ||
            !(side === "local" ? browser.local : browser.supported)) return;
        if (pane.busy) { pane.refreshPending = true; return; }
        const displayed = side === "local" ? browser.local.display(pane.path) : pane.path;
        if (pane.node.querySelector(".fm-path").value !== displayed) return;
        void this.load(pane, pane.path || (side === "local" ? browser.local.base : ""), true);
      }, 400);
    }
    filter(pane) {
      const compareName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.name.localeCompare(b.name);
      pane.visible = pane.entries.filter(entry => (pane.hidden || !entry.name.startsWith(".")) && entry.name.toLocaleLowerCase().includes(pane.query.toLocaleLowerCase()));
      pane.visible.sort((a, b) => {
        if (a.directory !== b.directory) return a.directory ? -1 : 1;
        if (pane.sort === "modified") {
          const aKnown = a.modified_ms != null || !!a.modified, bKnown = b.modified_ms != null || !!b.modified;
          if (aKnown !== bKnown) return aKnown ? -1 : 1;
        }
        const value = pane.sort === "size" && !a.directory ? a.size - b.size : pane.sort === "modified"
          ? (a.modified_ms ?? (Date.parse(a.modified) || 0)) - (b.modified_ms ?? (Date.parse(b.modified) || 0)) : compareName(a, b);
        return (value || compareName(a, b)) * (pane.descending ? -1 : 1);
      });
      pane.anchor = -1;
      this.paint(pane);
    }
    renderPane(pane) {
      const browser = this.browser;
      if (!browser) return;
      const unavailable = pane.side === "remote" && !browser.supported;
      const needsLocal = pane.side === "local" && !browser.local;
      const status = pane.node.querySelector(".fm-pane-status"), empty = pane.node.querySelector(".fm-pane-empty");
      status.textContent = pane.busy ? pane.progress : pane.error || "";
      status.hidden = !status.textContent;
      status.classList.toggle("fm-error", !!pane.error);
      pane.node.classList.toggle("fm-busy", pane.busy);
      pane.node.querySelector('[data-action="up"]').disabled = pane.busy || !pane.parent || pane.parent === pane.path;
      pane.node.querySelector('[data-action="tree"]').disabled = pane.busy || unavailable;
      pane.node.querySelector(".fm-path").disabled = pane.busy || unavailable || needsLocal;
      pane.node.querySelector(".fm-path").placeholder = needsLocal ? "选择本机目录" : unavailable ? "远端默认接收目录" : "输入路径，按 Enter 打开";
      empty.hidden = !(needsLocal || unavailable || (!pane.busy && !pane.error && !pane.visible.length));
      const emptyKey = `${needsLocal}:${unavailable}:${browser.supported}:${pane.entries.length}:${empty.hidden}`;
      if (emptyKey !== pane.emptyKey) {
      pane.emptyKey = emptyKey; empty.replaceChildren();
      if (!empty.hidden) {
        const heading = needsLocal ? "选择要浏览的本机目录" : unavailable ? browser.supported === null ? "等待远端目录能力…" : "远端使用默认接收目录"
          : pane.entries.length ? "没有匹配的文件" : "此目录为空";
        empty.append(el("strong", "", heading));
        if (needsLocal) {
          empty.append(el("p", "", typeof window.showDirectoryPicker === "function" ? "授权后可浏览、发送并接收文件夹" : "选择文件或文件夹发送，接收文件保存到浏览器下载目录"));
          const actions = el("div", "fm-empty-actions"), directory = el("button", "", "选择目录"), files = el("button", "", "选择文件");
          directory.onclick = () => void this.choose(); files.onclick = () => void this.choose(false);
          actions.append(directory, files); empty.append(actions);
        } else if (unavailable && browser.supported === false) empty.append(el("p", "", "仍可发送文件；更新客户端后可浏览远端目录"));
        else if (pane.entries.length) {
          const clear = el("button", "", "清空筛选"); clear.onclick = () => {
            pane.query = ""; pane.node.querySelector("input[type=search]").value = ""; this.filter(pane); this.renderPane(pane);
          }; empty.append(clear);
        }
      }
      }
      const selectable = pane.visible.filter(entry => !entry.link);
      const visibleSelected = selectable.filter(entry => pane.selected.has(entry.path)).length;
      const all = pane.node.querySelector(".fm-columns input");
      all.checked = selectable.length > 0 && visibleSelected === selectable.length;
      all.indeterminate = visibleSelected > 0 && visibleSelected < selectable.length;
      all.disabled = !selectable.length || pane.busy;
      pane.node.querySelector(".fm-count").textContent = `${pane.visible.length} 项${pane.selected.size ? ` · 已选 ${pane.selected.size} 项` : ""}`;
      pane.node.querySelector(".fm-sort-select").value = `${pane.sort}:${pane.descending ? "desc" : "asc"}`;
      for (const header of pane.node.querySelectorAll("[data-sort]")) {
        header.querySelector("span").textContent = header.dataset.sort === pane.sort ? pane.descending ? "⌄" : "⌃" : "";
        header.setAttribute("aria-label", `${header.textContent.trim()}，点击排序`);
      }
      this.paint(pane);
    }
    paint(pane) {
      pane.node.style.setProperty("--fm-scroll-space", `${pane.viewport.offsetWidth - pane.viewport.clientWidth + 8}px`);
      const focused = pane.rows.contains(document.activeElement) ? document.activeElement.closest("[data-index]")?.dataset.index : null;
      const height = 28, start = Math.max(0, Math.floor(pane.viewport.scrollTop / height) - 5);
      const end = Math.min(pane.visible.length, start + Math.ceil((pane.viewport.clientHeight || 320) / height) + 12);
      const renderKey = `${start}:${end}`;
      if (pane.renderedEntries === pane.visible && pane.renderKey === renderKey) {
        for (const row of pane.rows.children) {
          const selected = pane.selected.has(pane.visible[Number(row.dataset.index)].path);
          row.classList.toggle("selected", selected); row.setAttribute("aria-selected", String(selected));
          row.querySelector("input").checked = selected;
        }
        return;
      }
      pane.renderedEntries = pane.visible; pane.renderKey = renderKey;
      pane.rows.style.height = `${pane.visible.length * height}px`;
      pane.rows.replaceChildren();
      pane.viewport.setAttribute("aria-rowcount", String(pane.visible.length));
      for (let i = start; i < end; i++) {
        const entry = pane.visible[i], row = el("div", "fm-row"), check = el("input"), name = el("span", "fm-entry-name"), glyph = el("span", "fm-entry-icon");
        row.style.top = `${i * height}px`; row.dataset.index = i; row.tabIndex = 0; row.draggable = !entry.link;
        row.setAttribute("role", "row"); row.setAttribute("aria-rowindex", String(i + 1));
        row.setAttribute("aria-selected", String(pane.selected.has(entry.path))); row.classList.toggle("selected", pane.selected.has(entry.path));
        check.type = "checkbox"; check.disabled = !!entry.link; check.tabIndex = -1; check.checked = pane.selected.has(entry.path); check.setAttribute("aria-label", `选择 ${entry.name}`);
        const checkCell = el("label", "fm-check"); checkCell.append(check);
        glyph.innerHTML = icon(entry.directory ? "folder" : "file"); glyph.classList.toggle("is-folder", entry.directory);
        name.append(glyph, el("span", "fm-entry-text", entry.name)); name.title = entry.name + (entry.link ? " · 符号链接" : "");
        const date = el("span", "fm-date", typeof entry.modified === "string" ? entry.modified.slice(0, 10).replaceAll("-", "/") : "");
        const size = el("span", "fm-size", entry.directory ? "—" : format(entry.size));
        date.title = entry.modified || "";
        for (const cell of [checkCell, name, date, size]) cell.setAttribute("role", "gridcell");
        row.append(checkCell, name, date, size); pane.rows.append(row);
      }
      if (focused !== null) pane.rows.querySelector(`[data-index="${focused}"]`)?.focus({ preventScroll: true });
    }
    select(pane, index, event = {}) {
      const entry = pane.visible[index]; if (!entry || entry.link || pane.busy) return;
      this.source = pane.side;
      const other = this.panes[pane.side === "local" ? "remote" : "local"]; other.selected.clear();
      if (event.shiftKey && pane.anchor >= 0) {
        for (let i = Math.min(index, pane.anchor); i <= Math.max(index, pane.anchor); i++) if (!pane.visible[i].link) pane.selected.add(pane.visible[i].path);
      } else {
        if (pane.selected.has(entry.path)) pane.selected.delete(entry.path); else pane.selected.add(entry.path);
        pane.anchor = index;
      }
      this.renderPane(pane); this.renderPane(other); this.renderActions();
    }
    bindPane(pane) {
      const node = pane.node;
      node.querySelector("input[type=search]").oninput = event => { pane.query = event.target.value; pane.selected.clear(); pane.viewport.scrollTop = 0; this.filter(pane); this.renderPane(pane); this.renderActions(); };
      node.querySelector(".fm-hidden").onchange = event => { pane.hidden = event.target.checked; pane.selected.clear(); this.filter(pane); this.renderPane(pane); this.renderActions(); };
      node.querySelector('[data-action="up"]').onclick = () => void this.load(pane, pane.parent);
      node.querySelector('[data-action="tree"]').onclick = () => void this.tree(pane);
      node.querySelector(".fm-path").oninput = () => this.renderActions();
      node.querySelector(".fm-path").onkeydown = event => {
        if (event.key === "Enter") {
          const value = event.target.value.trim();
          void this.load(pane, pane.side === "local" ? this.browser.local.resolveDisplay(value) : value);
        }
      };
      node.querySelector(".fm-sort-select").onchange = event => {
        const [sort, order] = event.target.value.split(":"); pane.sort = sort; pane.descending = order === "desc"; this.filter(pane); this.renderPane(pane);
      };
      for (const header of node.querySelectorAll("[data-sort]")) header.onclick = () => {
        if (pane.sort === header.dataset.sort) pane.descending = !pane.descending;
        else { pane.sort = header.dataset.sort; pane.descending = pane.sort !== "name"; }
        this.filter(pane); this.renderPane(pane);
      };
      node.querySelector(".fm-columns input").onchange = event => {
        this.source = pane.side;
        const other = this.panes[pane.side === "local" ? "remote" : "local"]; other.selected.clear();
        for (const entry of pane.visible.filter(entry => !entry.link)) { if (event.target.checked) pane.selected.add(entry.path); else pane.selected.delete(entry.path); }
        this.renderPane(pane); this.renderPane(other); this.renderActions();
      };
      pane.viewport.onscroll = () => this.paint(pane);
      pane.rows.onclick = event => {
        if (event.target.closest("label") && event.target.tagName !== "INPUT") return;
        const row = event.target.closest("[data-index]"); if (row && event.detail < 2) this.select(pane, Number(row.dataset.index), event);
      };
      pane.rows.ondblclick = event => {
        const row = event.target.closest("[data-index]"), entry = row && pane.visible[Number(row.dataset.index)];
        if (entry?.directory) void this.load(pane, entry.path);
      };
      pane.viewport.oncontextmenu = event => {
        event.preventDefault();
        const row = event.target.closest("[data-index]"), entry = row && pane.visible[Number(row.dataset.index)];
        const menu = this.query(".fm-context"); menu.hidden = true;
        if (!entry?.directory || pane.busy) return;
        menu.hidden = false;
        const rect = this.dialog.getBoundingClientRect();
        menu.style.left = `${Math.max(4, Math.min(event.clientX - rect.left, rect.width - 130))}px`;
        menu.style.top = `${Math.max(4, Math.min(event.clientY - rect.top, rect.height - 44))}px`;
        menu.firstChild.onclick = () => { menu.hidden = true; void this.load(pane, entry.path); };
        menu.firstChild.focus();
      };
      pane.rows.onkeydown = event => {
        const row = event.target.closest("[data-index]"); if (!row) return;
        const index = Number(row.dataset.index), entry = pane.visible[index];
        if (event.key === " " || (event.key === "Enter" && !entry.directory)) { event.preventDefault(); this.select(pane, index, event); }
        if (event.key === "Enter" && entry.directory) { event.preventDefault(); void this.load(pane, entry.path); }
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault(); const next = Math.max(0, Math.min(pane.visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
          if (next * 28 < pane.viewport.scrollTop || (next + 1) * 28 > pane.viewport.scrollTop + pane.viewport.clientHeight) pane.viewport.scrollTop = next * 28;
          this.paint(pane); pane.rows.querySelector(`[data-index="${next}"]`)?.focus({ preventScroll: true });
        }
      };
      pane.rows.ondragstart = event => {
        const row = event.target.closest("[data-index]"), entry = row && pane.visible[Number(row.dataset.index)];
        if (!entry || entry.link || pane.busy || this.preparing || this.browser?.uploading) { event.preventDefault(); return; }
        if (!pane.selected.has(entry.path)) { pane.selected.clear(); this.select(pane, Number(row.dataset.index)); }
        this.drag = { browser: this.browser, side: pane.side, paths: [...pane.selected], ticket: pane.ticket };
        event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("application/x-crossdesk-files", pane.side);
      };
      pane.rows.ondragend = () => this.clearDrag();
      node.ondragover = event => {
        const external = !this.drag && pane.side === "remote" && this.browser?.ready && !pane.busy && !pane.error && !this.preparing && !this.browser.uploading && Array.from(event.dataTransfer.types).includes("Files");
        if ((this.drag?.browser === this.browser && this.drag.side !== pane.side && !pane.busy) || external) {
          event.preventDefault(); event.dataTransfer.dropEffect = "copy"; node.classList.add("fm-drop");
        }
      };
      node.ondragleave = event => { if (!node.contains(event.relatedTarget)) node.classList.remove("fm-drop"); };
      node.ondrop = event => {
        event.preventDefault(); node.classList.remove("fm-drop");
        const drag = this.drag; this.clearDrag();
        if (drag?.browser === this.browser && drag.side !== pane.side && drag.ticket === this.panes[drag.side].ticket) {
          this.source = drag.side; void this.send();
        } else if (!drag && pane.side === "remote") void this.dropExternal(event.dataTransfer);
      };
    }
    async dropExternal(data) {
      if (!this.browser?.ready || this.panes.remote.busy || this.panes.remote.error || this.preparing || this.browser.uploading) return;
      // Capture handles during the drop event, before the browser protects DataTransfer.
      const entries = Array.from(data.items || []).filter(item => item.kind === "file");
      const folderFallback = entries.some(item => (item.getAsEntry?.() || item.webkitGetAsEntry?.())?.isDirectory && !item.getAsFileSystemHandle);
      const requests = entries.map(item =>
        item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : Promise.resolve(null));
      const files = Array.from(data.files || []), browser = this.browser;
      try {
        if (folderFallback) throw new Error("当前浏览器请通过“选择目录”发送文件夹。");
        const handles = await Promise.all(requests);
        if (this.browser !== browser || browser.closed) return;
        if (handles.length && handles.every(Boolean)) {
          const root = { name: "拖入的文件", kind: "directory", async *values() { yield* handles; },
            async getDirectoryHandle(name) { const h = handles.find(h => h.name === name && h.kind === "directory"); if (!h) throw new DOMException("Not found", "NotFoundError"); return h; },
            async getFileHandle(name) { const h = handles.find(h => h.name === name && h.kind === "file"); if (!h) throw new DOMException("Not found", "NotFoundError"); return h; } };
          const local = new window.CrossDeskLocalDirectory(root);
          await browser.upload(handles.map(h => local.base + "/" + h.name), this.panes.remote.path, local);
        } else if (files.length) {
          const local = new window.CrossDeskLocalDirectory(null, files);
          await browser.upload(files.map(f => local.base + "/" + f.name), this.panes.remote.path, local);
        }
      } catch (error) { this.report(error); }
    }
    clearDrag() { this.drag = null; for (const pane of Object.values(this.panes)) pane.node.classList.remove("fm-drop"); }
    dismissTrees() { for (const pane of Object.values(this.panes)) { pane.node.querySelector(".fm-tree").hidden = true; pane.treeToken = {}; } }
    dismissMenus() { this.dismissTrees(); this.query(".fm-context").hidden = true; }
    async tree(pane) {
      const popup = pane.node.querySelector(".fm-tree"), wasOpen = !popup.hidden;
      this.dismissTrees(); if (wasOpen) return;
      if (pane.side === "local" && !this.browser.local) { await this.choose(); return; }
      const browser = this.browser, token = pane.treeToken;
      const current = () => this.browser === browser && !browser.closed && pane.treeToken === token && !popup.hidden;
      popup.replaceChildren(); popup.hidden = false;
      const toolbar = el("div", "fm-tree-toolbar"); popup.append(toolbar);
      const home = el("button", "", pane.side === "local" ? "根目录" : "主目录");
      home.onclick = () => void this.load(pane, pane.side === "local" ? browser.local.base : ""); toolbar.append(home);
      const change = el("button", "", pane.side === "local" ? "更换目录" : "磁盘");
      change.onclick = () => pane.side === "local" ? void this.choose() : void this.load(pane, "@roots"); toolbar.append(change);
      if (pane.side === "local") { const files = el("button", "", "选择文件"); files.onclick = () => void this.choose(false); toolbar.append(files); }
      const tree = el("div", "fm-tree-list"); popup.append(tree);
      const add = (entry, container, depth) => {
        const row = el("div", "fm-tree-row"), toggle = el("button", "", "›"), open = el("button", "", entry.name), children = el("div");
        row.style.paddingLeft = `${Math.min(depth, 8) * 12}px`; toggle.setAttribute("aria-label", `展开 ${entry.name}`); toggle.setAttribute("aria-expanded", "false");
        open.onclick = () => void this.load(pane, entry.path);
        toggle.onclick = async () => {
          if (children.childNodes.length) { children.hidden = !children.hidden; toggle.textContent = children.hidden ? "›" : "⌄"; toggle.setAttribute("aria-expanded", String(!children.hidden)); return; }
          toggle.disabled = true;
          try {
            const listing = pane.side === "local" ? await browser.local.list(entry.path, current) : await browser.listRemote(entry.path, current);
            if (!current()) return;
            for (const child of listing.entries.filter(e => e.directory && (pane.hidden || !e.name.startsWith("."))))
              add({ ...child, path: child.path || window.CrossDeskFileBrowser.join(listing.path, child.name) }, children, depth + 1);
            if (!children.childNodes.length) children.append(el("span", "fm-tree-empty", "无子目录"));
            toggle.textContent = "⌄"; toggle.setAttribute("aria-expanded", "true");
          } catch (error) { if (current()) this.report(error); }
          finally { toggle.disabled = false; }
        };
        row.append(toggle, open); container.append(row, children);
      };
      for (const entry of pane.visible.filter(entry => entry.directory)) add(entry, tree, 0);
      if (!tree.childNodes.length) tree.append(el("span", "fm-tree-empty", "当前目录没有子目录"));
    }
    renderActions() {
      const browser = this.browser, source = this.panes[this.source], target = this.panes[this.source === "local" ? "remote" : "local"];
      if (!browser) return;
      const send = this.query(".fm-send"); send.textContent = this.source === "local" ? "发送到远端" : "发送到本机";
      const pathPending = Object.values(this.panes).some(pane => pane.loaded && !pane.error && pane.node.querySelector(".fm-path").value !== (pane.side === "local" ? browser.local?.display(pane.path) : pane.path));
      send.disabled = !browser.ready || !source.selected.size || source.busy || target.busy || !!source.error || !!target.error || this.preparing || browser.uploading || pathPending ||
        (this.source === "remote" && !browser.supported) || (this.source === "local" && browser.supported && (!target.loaded || target.path === "@roots"));
      this.query(".fm-hint").textContent = !browser.files.ready ? browser.files.state === "unsupported" ? "远端暂不支持文件传输，请更新客户端" : "等待文件通道连接…"
        : this.preparing || browser.uploading ? "正在准备传输…" : source.selected.size ? `已选 ${source.selected.size} 项 · ${this.source === "local" ? "发送到远端当前目录" : browser.local?.handle ? "发送到本机当前目录" : "保存到浏览器下载目录"}` : "双击打开目录，拖到另一侧发送";
    }
    async send() {
      this.renderActions(); if (this.query(".fm-send").disabled) return;
      const browser = this.browser, source = this.panes[this.source], paths = [...source.selected];
      if (paths.length > 256) { this.report(window.CrossDeskFileBrowser.failure("too_many_selected")); return; }
      this.preparing = true; this.renderActions();
      try {
        if (this.source === "local") await browser.upload(paths, this.panes.remote.path);
        else await browser.download(source.entries.filter(entry => source.selected.has(entry.path)), this.panes.local.path);
        if (browser === this.browser) { source.selected.clear(); this.renderPane(source); }
      } catch (error) { if (browser === this.browser) this.report(error); }
      finally { if (browser === this.browser) { this.preparing = false; this.renderActions(); } }
    }
    renderTasks() {
      const items = this.browser?.files.items.filter(item => item.direction === "send") || [];
      const busy = items.filter(running).length, list = this.query(".fm-tasks");
      const toggle = this.query(".fm-tasks-toggle");
      toggle.textContent = `${this.expanded ? "⌄" : "›"} 传输任务 · ${items.length ? `${items.length} 项${busy ? `，${busy} 项进行中` : ""}` : "暂无任务"}`;
      toggle.setAttribute("aria-expanded", String(!!this.expanded)); list.hidden = !this.expanded;
      this.query(".fm-clear").disabled = !items.some(item => !running(item));
      if (!this.expanded) return;
      const scroll = list.scrollTop;
      const key = `${Math.floor(scroll / 40)}:${items.map(item => item.id).join(",")}`;
      if (this.taskKey === key && this.taskBrowser === this.browser) {
        for (const row of list.querySelectorAll(".fm-task")) {
          const item = items[Number(row.dataset.index)];
          row.querySelector("progress").value = item.status === "completed" ? 1 : item.total ? item.bytes / item.total : 0;
          const status = row.querySelector(".fm-task-status"); status.textContent = labels[item.status]; status.title = item.detail || ""; status.classList.toggle("fm-error", item.status === "failed");
          const cancel = row.querySelector("button"); cancel.textContent = running(item) ? "取消" : "×";
          cancel.setAttribute("aria-label", `${running(item) ? "取消发送" : "移除记录"} ${item.name}`);
        }
        return;
      }
      this.taskKey = key; this.taskBrowser = this.browser; list.replaceChildren();
      if (!items.length) list.append(el("p", "fm-no-tasks", "暂无传输任务"));
      // Virtualize long queues as well as directory lists.
      const height = 40, start = Math.max(0, Math.floor(scroll / height) - 2), end = Math.min(items.length, start + 12);
      const content = el("div", "fm-task-rows"); content.style.height = `${items.length * height}px`; list.append(content);
      for (let i = start; i < end; i++) {
        const item = items[i], row = el("div", "fm-task"), name = el("span", "fm-task-name", item.name), size = el("span", "fm-task-size", format(item.total));
        row.style.top = `${i * height}px`; row.dataset.index = i; name.title = item.name;
        const identity = el("div", "fm-task-identity"); identity.append(name, size);
        const progress = el("progress"); progress.max = 1; progress.value = item.status === "completed" ? 1 : item.total ? item.bytes / item.total : 0;
        progress.setAttribute("aria-label", `${item.name} 发送进度`);
        const status = el("span", "fm-task-status", labels[item.status] || item.status); status.title = item.detail || ""; status.classList.toggle("fm-error", item.status === "failed");
        const cancel = el("button", "fm-task-cancel", running(item) ? "取消" : "×");
        cancel.setAttribute("aria-label", `${running(item) ? "取消发送" : "移除记录"} ${item.name}`);
        cancel.onclick = () => running(item) ? this.browser.files.cancel(item) : this.browser.files.remove(item);
        row.append(identity, progress, status, cancel); content.append(row);
      }
      list.scrollTop = scroll; list.onscroll = () => this.renderTasks();
    }
  }
  window.CrossDeskFileManager = new FileManager();
})();
