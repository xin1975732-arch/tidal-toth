/* 账本三部曲 · 阅读器功能 features.js —— kit v2.0
 *
 * 在 reader.js 之后加载。分两层：
 *   本机（不用登录，存在读者自己的浏览器里）：划线、批注、书签、全文搜索、人物卡片与关系图、
 *     时间线、前情提要、金句卡片、我的书房（阅读时长、连读天数、读完几章）
 *   共享（要在 claude.ai 里打开、页面声明了 db / user 能力才有）：章末评论、段落评论、点赞、回复、
 *     读后感、读者主页、作者后台（阅读统计、热门划线、删评论、改前情提要）
 *
 * 共享数据的路径（db 规则见套件说明）：
 *   u/<读者id>   这位读者公开的一切：评论、点赞、公开划线、读后感、公开的阅读进度
 *   s/<读者id>   阅读统计，只有作者和本人能读
 *   edit/recaps  作者改过的前情提要
 */
(function () {
  "use strict";
  var R = window.Reader;
  if (!R) return;
  var D = R.data, CH = R.chapters, N = CH.length, esc = R.esc, el = R.el, pad = R.pad;
  var PEOPLE = (D.people && D.people.people) || [];
  var PBY = {};
  PEOPLE.forEach(function (p) { PBY[p.id] = p; });
  var GROUPS = (D.people && D.people.groups) || [];
  var TL = (D.timeline && D.timeline.events) || [];
  var ERAS = (D.timeline && D.timeline.eras) || [];
  var SAFE_ID = /^[A-Za-z0-9._~-]{1,180}$/;
  var SOCIAL = D.social !== false;   // false：不要评论、读后感、读者主页、作者后台（纯静态版）

  function uid8() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function today() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function ago(ts) {
    var s = (Date.now() - ts) / 1000;
    if (s < 60) return "刚刚";
    if (s < 3600) return Math.floor(s / 60) + " 分钟前";
    if (s < 86400) return Math.floor(s / 3600) + " 小时前";
    if (s < 86400 * 30) return Math.floor(s / 86400) + " 天前";
    var d = new Date(ts);
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }
  function dur(sec) {
    sec = Math.round(sec || 0);
    if (sec < 60) return sec + " 秒";
    var m = Math.round(sec / 60);
    if (m < 60) return m + " 分钟";
    return Math.floor(m / 60) + " 小时 " + (m % 60) + " 分";
  }
  function chName(n) { var c = CH[n - 1]; return c ? "第" + c.cn + "章　" + c.title : ""; }
  function chShort(n) { var c = CH[n - 1]; return c ? "第" + c.cn + "章" : ""; }
  function paraText(n, p) { var c = CH[n - 1]; return (c && c.paras[p]) || ""; }
  function snip(s, max) { s = String(s || ""); return s.length > max ? s.slice(0, max) + "……" : s; }
  function shareLink(n, p) {
    var base = D.share_url || (location.href.split("#")[0]);
    return base + R.chHref(n, p);
  }
  function copyText(text, okMsg) {
    var done = function () { R.toast(okMsg || "已复制"); };
    var fail = function () {
      var box = el("div", { class: "copy-fallback" });
      var inp = el("input", { type: "text", value: text, "aria-label": "链接", readonly: true });
      box.appendChild(el("p", { text: "这里不能直接复制，请长按或选中下面的链接：" }));
      box.appendChild(inp);
      R.sheet({ title: "复制链接", body: box });
      setTimeout(function () { inp.focus(); inp.select(); }, 60);
    };
    try { navigator.clipboard.writeText(text).then(done, fail); } catch (e) { fail(); }
  }

  /* =====================================================================
   * 本机数据
   * ===================================================================== */
  var L = {
    hl: R.getJSON("hl", []),           // {id,ch,p,s,e,t,note,ts}
    bm: R.getJSON("bm", []),           // {id,ch,p,ts}
    time: R.getJSON("time", {}),       // {ch: 秒}
    days: R.getJSON("days", []),       // ["2026-10-14", ...]
    first: parseInt(R.get("first") || "0", 10),
    prefs: R.getJSON("prefs", { pubHl: false, pubStats: false })
  };
  if (!L.first) { L.first = Date.now(); R.set("first", String(L.first)); }
  function saveL(k) { R.setJSON(k, L[k]); }
  function streak() {
    var set = {}; L.days.forEach(function (d) { set[d] = 1; });
    var n = 0, d = new Date();
    if (!set[today()]) d.setDate(d.getDate() - 1);
    for (;;) {
      var k = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
      if (!set[k]) break;
      n++; d.setDate(d.getDate() - 1);
    }
    return n;
  }
  function doneList() { return (R.get("done") || "").split(",").filter(Boolean).map(Number).sort(function (a, b) { return a - b; }); }
  function totalTime() { var s = 0; Object.keys(L.time).forEach(function (k) { s += L.time[k] || 0; }); return s; }

  /* =====================================================================
   * 共享能力：db / user / downloads
   * ===================================================================== */
  var C = { ready: false, db: null, user: null, dl: null, sample: null, uid: null, me: null, owner: false, readonly: false };
  var S = { users: {}, loaded: false, recaps: {}, statsBase: null };
  var live = [];                // 当前页面里要随共享数据刷新的函数
  function addLive(fn) { live.push(fn); fn(); }
  function refreshLive() { live.forEach(function (fn) { try { fn(); } catch (e) { if (window.console) console.error(e); } }); }
  R.on("leave", function () { live = []; flushStats(); });

  function use(name) {
    try { return (window.claude && window.claude.use) ? window.claude.use(name).catch(function () { return null; }) : Promise.resolve(null); }
    catch (e) { return Promise.resolve(null); }
  }
  function initCaps() {
    Promise.all([SOCIAL ? use("db") : null, SOCIAL ? use("user") : null, use("downloads"), use("sample")]).then(function (r) {
      C.db = r[0]; C.user = r[1]; C.dl = r[2]; C.sample = r[3];
      if (!C.user) return null;
      return Promise.all([C.user.id().catch(function () { return null; }), C.user.me().catch(function () { return null; })]);
    }).then(function (r) {
      if (r) { C.uid = r[0]; C.me = r[1]; C.owner = !!(r[1] && r[1].isOwner); }
      if (C.user && C.user.can) {
        return Promise.resolve(C.user.can("data.write")).then(function (w) { if (w === false) C.readonly = true; }, function () {});
      }
    }).then(function () {
      C.ready = true;
      if (C.db) {
        try {
          C.db.collection("u").onSnapshot(function (snap) {
            var m = {};
            snap.docs.forEach(function (d) { if (d.exists) m[d.id] = d.data(); });
            S.users = m; S.loaded = true;
            refreshLive();
          }, function () { S.loaded = true; refreshLive(); });
          C.db.doc("edit/recaps").onSnapshot(function (d) { S.recaps = (d.exists && d.data()) || {}; refreshLive(); }, function () {});
        } catch (e) { C.db = null; }
        if (C.uid) loadStatsBase();
      }
      refreshLive();
      R.emit("caps");
    });
  }
  function shared() { return !!(C.db && C.uid && !C.readonly); }
  function sharedState() {
    if (!C.ready) return "wait";
    if (!C.db) return "nodb";
    if (!C.uid) return "anon";
    if (C.readonly) return "readonly";
    return "ok";
  }
  var AUTH = window.READER_AUTH || null;
  function sharedNote() {
    var s = sharedState();
    if (s === "wait") return "正在连接……";
    if (AUTH) {
      if (s === "nodb") return "评论区暂时连不上，稍后再试。";
      if (s === "anon") return "登录后可以评论：输入邮箱，收验证码，起个昵称就行。";
      if (s === "readonly") return "你现在只能看，不能发。";
      return "";
    }
    if (s === "nodb") return "评论和读后感要在 claude.ai 里打开这本书才能看到。";
    if (s === "anon") return "登录 claude.ai 之后可以参与评论。";
    if (s === "readonly") return "你现在可以看，但还不能发。想参与讨论，请作者在分享设置里把你的权限改成可以参与。";
    return "";
  }
  function loginBtn() {
    var b = el("button", { type: "button", class: "btn-s pri", text: "邮箱登录" });
    b.addEventListener("click", function () { AUTH.login(); });
    return b;
  }

  function myDoc() { return S.users[C.uid] || null; }
  function baseDoc() { return { v: 1, joined: Date.now(), comments: [], likes: [], hl: [], review: null, stats: null }; }
  var wq = Promise.resolve();
  function writeMine(mut) {
    if (!shared()) { R.toast(sharedNote()); return Promise.resolve(false); }
    wq = wq.then(function () {
      var d = myDoc() ? clone(myDoc()) : baseDoc();
      if (!d.comments) d.comments = [];
      if (!d.likes) d.likes = [];
      mut(d);
      return C.db.doc("u/" + C.uid).set(d).then(function () { S.users[C.uid] = d; refreshLive(); return true; });
    }).catch(writeErr);
    return wq;
  }
  function writeErr(err) {
    var code = err && err.code;
    if (code === "invalid_argument" || code === "not_granted") { C.readonly = true; R.toast(sharedNote()); refreshLive(); }
    else if (code === "quota_exceeded") R.toast("存储已满，请联系作者。");
    else R.toast("没有发出去，稍后再试一次。");
    return false;
  }
  function allComments() {
    var out = [];
    Object.keys(S.users).forEach(function (u) {
      (S.users[u].comments || []).forEach(function (c) { var x = clone(c); x.uid = u; out.push(x); });
    });
    return out;
  }
  function likeCounts() {
    var m = {};
    Object.keys(S.users).forEach(function (u) { (S.users[u].likes || []).forEach(function (id) { m[id] = (m[id] || 0) + 1; }); });
    return m;
  }
  function names(ids) {
    if (!C.user || !ids.length) return Promise.resolve({});
    return C.user.profiles(ids).catch(function () { return {}; });
  }
  function personTag(id, map) {
    var p = map[id] || {};
    var nm = p.name || (id === C.uid ? "我" : "一位读者");
    var a = el(SAFE_ID.test(id) ? "a" : "span", { class: "who" });
    if (SAFE_ID.test(id)) a.href = "#reader-" + id;
    if (p.avatarUrl) a.appendChild(el("img", { src: p.avatarUrl, alt: "", width: 22, height: 22 }));
    a.appendChild(el("span", { text: nm }));
    return a;
  }

  /* =====================================================================
   * 阅读统计（本机 + 共享 s/<id>）
   * ===================================================================== */
  var act = { last: Date.now(), ch: 0, dirty: false, tick: 0, lastFlush: 0 };
  ["scroll", "pointerdown", "keydown", "touchstart"].forEach(function (ev) {
    window.addEventListener(ev, function () { act.last = Date.now(); }, { passive: true });
  });
  setInterval(function () {
    if (!act.ch || document.hidden || Date.now() - act.last > 60000) return;
    L.time[act.ch] = (L.time[act.ch] || 0) + 5;
    act.dirty = true;
    if (L.days[L.days.length - 1] !== today()) { L.days.push(today()); if (L.days.length > 400) L.days = L.days.slice(-400); saveL("days"); }
    if (++act.tick % 6 === 0) saveL("time");
    if (Date.now() - act.lastFlush > 90000) flushStats();
  }, 5000);
  document.addEventListener("visibilitychange", function () { if (document.hidden) { saveL("time"); flushStats(); } });
  R.on("chapter", function (n) { act.ch = n; act.last = Date.now(); bumpVisit(n); });
  R.on("leave", function () { act.ch = 0; saveL("time"); });
  R.on("done", function () { flushStats(true); if (L.prefs.pubStats) pushPublicStats(); });

  var visits = R.getJSON("visits", {});
  function bumpVisit(n) { visits[n] = (visits[n] || 0) + 1; R.setJSON("visits", visits); act.dirty = true; }

  function loadStatsBase() {
    C.db.doc("s/" + C.uid).get().then(function (d) {
      S.statsBase = (d.exists && d.data()) || { first: L.first, ch: {}, days: [] };
      // 别的设备读过的时长，取大的那个
      var ch = S.statsBase.ch || {};
      Object.keys(ch).forEach(function (k) { if ((ch[k].sec || 0) > (L.time[k] || 0)) L.time[k] = ch[k].sec; });
      saveL("time");
    }).catch(function () {});
  }
  var statsBusy = false;
  function flushStats(force) {
    if (!C.db || !C.uid || C.readonly || !S.statsBase || statsBusy) return;
    if (!act.dirty && !force) return;
    act.dirty = false; act.lastFlush = Date.now();
    var done = doneList();
    var ch = {};
    for (var i = 1; i <= N; i++) {
      var sec = L.time[i] || 0, v = visits[i] || 0, dn = done.indexOf(i) >= 0;
      if (sec || v || dn) ch[i] = { sec: sec, v: v, done: dn };
    }
    var days = (S.statsBase.days || []).concat(L.days).filter(function (d, i, a) { return a.indexOf(d) === i; }).sort().slice(-400);
    var doc = { first: Math.min(S.statsBase.first || L.first, L.first), last: Date.now(), ch: ch, days: days };
    statsBusy = true;
    C.db.doc("s/" + C.uid).set(doc).then(function () { S.statsBase = doc; }, function (e) { if (e && e.code === "invalid_argument") C.readonly = true; })
      .then(function () { statsBusy = false; });
  }
  function pushPublicStats() {
    writeMine(function (d) { d.stats = L.prefs.pubStats ? { done: doneList(), sec: totalTime() } : null; });
  }

  /* =====================================================================
   * 划线、批注、书签
   * ===================================================================== */
  function chapterArticle() { return document.querySelector("#view article.text"); }
  var orig = {};   // 本章每段的原始 HTML
  function paraEl(p) { var a = chapterArticle(); return a ? a.querySelector('[data-p="' + p + '"]') : null; }

  function textOffset(pEl, node, off) {
    var r = document.createRange();
    r.setStart(pEl, 0);
    try { r.setEnd(node, off); } catch (e) { return 0; }
    return r.toString().length;
  }
  function wrapRange(pEl, s, e, make) {
    var walker = document.createTreeWalker(pEl, NodeFilter.SHOW_TEXT, null);
    var pos = 0, nodes = [], t;
    while ((t = walker.nextNode())) { nodes.push([t, pos, pos + t.data.length]); pos += t.data.length; }
    nodes.forEach(function (x) {
      var node = x[0], a = x[1], b = x[2];
      var from = Math.max(s, a), to = Math.min(e, b);
      if (from >= to) return;
      var mid = node;
      if (from > a) mid = mid.splitText(from - a);
      if (to < b) mid.splitText(to - from);
      var w = make();
      mid.parentNode.insertBefore(w, mid);
      w.appendChild(mid);
    });
  }
  function paintPara(n, p) {
    var pEl = paraEl(p);
    if (!pEl) return;
    if (orig[p] == null) orig[p] = pEl.innerHTML;
    pEl.innerHTML = orig[p];
    L.hl.filter(function (h) { return h.ch === n && h.p === p; }).sort(function (a, b) { return a.s - b.s; }).forEach(function (h) {
      wrapRange(pEl, h.s, h.e, function () {
        var m = el("mark", { class: "hl" + (h.note ? " has-note" : ""), "data-id": h.id, tabindex: "0" });
        return m;
      });
    });
    pEl.classList.toggle("bm", L.bm.some(function (b) { return b.ch === n && b.p === p; }));
  }
  function paintChapter(n) {
    orig = {};
    var ps = {};
    L.hl.forEach(function (h) { if (h.ch === n) ps[h.p] = 1; });
    L.bm.forEach(function (b) { if (b.ch === n) ps[b.p] = 1; });
    Object.keys(ps).forEach(function (p) { paintPara(n, +p); });
  }
  function addHl(n, p, s, e, note) {
    var t = paraText(n, p).slice(s, e);
    var h = { id: "h" + uid8(), ch: n, p: p, s: s, e: e, t: t, note: note || "", ts: Date.now() };
    L.hl.push(h); saveL("hl"); paintPara(n, p);
    if (L.prefs.pubHl) syncPublicHl();
    return h;
  }
  function delHl(id) {
    var h = L.hl.filter(function (x) { return x.id === id; })[0];
    L.hl = L.hl.filter(function (x) { return x.id !== id; }); saveL("hl");
    if (h && R.current().ch === h.ch) paintPara(h.ch, h.p);
    if (L.prefs.pubHl) syncPublicHl();
  }
  function toggleBm(n, p) {
    var has = L.bm.some(function (b) { return b.ch === n && b.p === p; });
    if (has) L.bm = L.bm.filter(function (b) { return !(b.ch === n && b.p === p); });
    else L.bm.push({ id: "b" + uid8(), ch: n, p: p, ts: Date.now() });
    saveL("bm");
    if (R.current().ch === n) paintPara(n, p);
    R.toast(has ? "书签已取消" : "已加书签，在“我的书房”里能找到");
  }
  function syncPublicHl() {
    if (!shared()) return;
    writeMine(function (d) { d.hl = L.prefs.pubHl ? L.hl.map(function (h) { return { ch: h.ch, p: h.p, s: h.s, e: h.e, t: h.t, ts: h.ts }; }) : []; });
  }

  function noteEditor(h) {
    var box = el("div", { class: "note-ed" });
    box.appendChild(el("blockquote", { class: "q", text: h.t }));
    var ta = el("textarea", { id: "noteTa", rows: 5, maxlength: 1000, placeholder: "写下你的批注（只存在这台设备上）" });
    ta.value = h.note || "";
    box.appendChild(ta);
    var row = el("div", { class: "row" });
    var save = el("button", { class: "btn-s pri", type: "button", text: "保存批注" });
    var del = el("button", { class: "btn-s", type: "button", text: "删除这条划线" });
    row.appendChild(save); row.appendChild(del);
    box.appendChild(row);
    var sh = R.sheet({ title: "批注 · " + chShort(h.ch) + "第" + (h.p + 1) + "段", body: box });
    setTimeout(function () { ta.focus(); }, 80);
    save.addEventListener("click", function () {
      h.note = ta.value.trim(); h.ts = Date.now(); saveL("hl");
      if (R.current().ch === h.ch) paintPara(h.ch, h.p);
      sh.close(); R.toast(h.note ? "批注已保存" : "已保存");
    });
    del.addEventListener("click", function () { delHl(h.id); sh.close(); R.toast("划线已删除"); });
  }

  /* 选中文字后的浮动工具条 */
  var tb = el("div", { class: "seltb", role: "toolbar", "aria-label": "划线工具", hidden: true });
  tb.innerHTML = '<button type="button" data-a="hl">划线</button><button type="button" data-a="note">批注</button><button type="button" data-a="card">金句卡</button><button type="button" data-a="link">复制链接</button>';
  document.body.appendChild(tb);
  var selInfo = null;
  function readSel() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var a = chapterArticle();
    if (!a) return null;
    var r = sel.getRangeAt(0);
    var sp = (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode).closest("[data-p]");
    if (!sp || !a.contains(sp)) return null;
    var s = textOffset(sp, r.startContainer, r.startOffset);
    var ep = (r.endContainer.nodeType === 1 ? r.endContainer : r.endContainer.parentNode).closest("[data-p]");
    var e = ep === sp ? textOffset(sp, r.endContainer, r.endOffset) : sp.textContent.length;
    if (e - s < 1) return null;
    return { n: R.current().ch, p: +sp.getAttribute("data-p"), s: s, e: e, rect: r.getBoundingClientRect() };
  }
  var selT = 0;
  function showTb() {
    clearTimeout(selT);
    selT = setTimeout(function () {
      selInfo = readSel();
      if (!selInfo) { tb.hidden = true; return; }
      tb.hidden = false;
      var rc = selInfo.rect, w = tb.offsetWidth, h = tb.offsetHeight;
      var touch = window.matchMedia("(pointer: coarse)").matches;
      var x = Math.min(window.innerWidth - w - 8, Math.max(8, rc.left + rc.width / 2 - w / 2));
      var y = touch ? rc.bottom + 14 : rc.top - h - 10;
      if (y < 60) y = rc.bottom + 14;
      if (y + h > window.innerHeight - 8) y = Math.max(60, rc.top - h - 10);
      y = Math.min(Math.max(y, 60), window.innerHeight - h - 8);
      tb.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
    }, 180);
  }
  document.addEventListener("selectionchange", function () { if (R.current().ch) showTb(); else tb.hidden = true; });
  window.addEventListener("scroll", function () { if (!tb.hidden) showTb(); }, { passive: true });
  tb.addEventListener("pointerdown", function (e) { e.preventDefault(); });
  tb.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b || !selInfo) return;
    var s = selInfo, act = b.getAttribute("data-a");
    var text = paraText(s.n, s.p).slice(s.s, s.e);
    window.getSelection().removeAllRanges();
    tb.hidden = true;
    if (act === "hl") { addHl(s.n, s.p, s.s, s.e); R.toast("已划线"); }
    else if (act === "note") { noteEditor(addHl(s.n, s.p, s.s, s.e)); }
    else if (act === "card") { quoteCard(text, s.n, s.p); }
    else if (act === "link") { copyText(shareLink(s.n, s.p), "这一段的链接已复制"); }
  });

  /* 点段落：书签 / 评论 / 金句卡 / 链接 */
  var pm = el("div", { class: "paramenu", role: "menu", hidden: true });
  document.body.appendChild(pm);
  var pmInfo = null;
  function hidePm() { pm.hidden = true; pmInfo = null; var a = document.querySelector(".text [data-p].picked"); if (a) a.classList.remove("picked"); }
  var pmY = 0;
  window.addEventListener("scroll", function () { if (!pm.hidden && Math.abs(window.scrollY - pmY) > 60) hidePm(); }, { passive: true });
  document.addEventListener("click", function (e) {
    if (pm.contains(e.target)) return;
    var a = chapterArticle();
    if (!a || !a.contains(e.target)) { hidePm(); return; }
    var mk = e.target.closest("mark.hl");
    if (mk) { hidePm(); var h = L.hl.filter(function (x) { return x.id === mk.getAttribute("data-id"); })[0]; if (h) hlMenu(h, mk); return; }
    var rn = e.target.closest(".rn");
    if (rn) { hidePm(); personCard(rn.getAttribute("data-c")); return; }
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    var p = e.target.closest("[data-p]");
    if (!p) { hidePm(); return; }
    if (pmInfo && pmInfo.el === p) { hidePm(); return; }
    hidePm();
    var n = R.current().ch, pi = +p.getAttribute("data-p");
    pmInfo = { el: p, n: n, p: pi };
    p.classList.add("picked");
    var has = L.bm.some(function (b) { return b.ch === n && b.p === pi; });
    var cnt = paraComments(n, pi).length;
    pm.innerHTML = '<button type="button" data-a="bm">' + (has ? "取消书签" : "书签") + "</button>" +
      (SOCIAL ? '<button type="button" data-a="cm">评论' + (cnt ? " " + cnt : "") + "</button>" : "") +
      '<button type="button" data-a="card">金句卡</button><button type="button" data-a="link">链接</button>';
    pm.hidden = false;
    pmY = window.scrollY;
    var rc = p.getBoundingClientRect();
    var w = pm.offsetWidth;
    var x = Math.min(window.innerWidth - w - 8, Math.max(8, e.clientX - w / 2));
    var y = e.clientY + 18;
    if (y + pm.offsetHeight > window.innerHeight - 8) y = e.clientY - pm.offsetHeight - 18;
    pm.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
    void rc;
  });
  pm.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b || !pmInfo) return;
    var i = pmInfo, a = b.getAttribute("data-a");
    hidePm();
    if (a === "bm") toggleBm(i.n, i.p);
    else if (a === "cm") paraThread(i.n, i.p);
    else if (a === "card") quoteCard(paraText(i.n, i.p), i.n, i.p);
    else if (a === "link") copyText(shareLink(i.n, i.p), "这一段的链接已复制");
  });
  function hlMenu(h) {
    var box = el("div", { class: "hl-pop" });
    box.appendChild(el("blockquote", { class: "q", text: h.t }));
    if (h.note) box.appendChild(el("p", { class: "note-show", text: h.note }));
    var row = el("div", { class: "row" });
    [["note", h.note ? "改批注" : "写批注"], ["card", "金句卡"], ["link", "复制链接"], ["del", "删除划线"]].forEach(function (x) {
      row.appendChild(el("button", { class: "btn-s" + (x[0] === "note" ? " pri" : ""), type: "button", "data-a": x[0], text: x[1] }));
    });
    box.appendChild(row);
    var sh = R.sheet({ title: "我的划线", body: box });
    row.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      var a = b.getAttribute("data-a");
      sh.close();
      if (a === "note") noteEditor(h);
      else if (a === "card") quoteCard(h.t, h.ch, h.p);
      else if (a === "link") copyText(shareLink(h.ch, h.p), "链接已复制");
      else if (a === "del") { delHl(h.id); R.toast("划线已删除"); }
    });
  }

  /* =====================================================================
   * 金句卡片
   * ===================================================================== */
  var TPLS = [
    { id: "min", name: "极简" },
    { id: "art", name: "文艺" },
    { id: "dark", name: "暗黑" }
  ];
  function cssVar(n, d) { var v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v || d; }
  function wrapLines(ctx, text, maxW) {
    var noStart = "，。、；：！？”’」』）》…—,.;:!?)";
    var lines = [], line = "";
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === "\n") { lines.push(line); line = ""; continue; }
      if (ctx.measureText(line + ch).width > maxW && line) {
        if (noStart.indexOf(ch) >= 0) { line += ch; continue; }
        lines.push(line); line = ch;
      } else line += ch;
    }
    if (line) lines.push(line);
    return lines;
  }
  function drawCard(cv, text, n, p, tpl) {
    var W = 1080, H = 1350, ctx = cv.getContext("2d");
    cv.width = W; cv.height = H;
    var serif = cssVar("--serif", "serif"), display = cssVar("--display", serif);
    var pal;
    if (tpl === "dark") pal = { bg: "#17121A", ink: "#F3E8DC", sub: "#B9A79A", acc: "#FF8547", acc2: "#6FA7FF", rule: "#3A2E3A" };
    else if (tpl === "art") pal = { bg: cssVar("--bg-2", "#FFE3D0"), ink: cssVar("--ink", "#3A1E17"), sub: cssVar("--ink-2", "#6B3F33"), acc: cssVar("--acc", "#FF6A2B"), acc2: cssVar("--alt", "#4D8EF7"), rule: cssVar("--hard", "#3A1E17") };
    else pal = { bg: "#FBF8F2", ink: "#231C17", sub: "#7A6E64", acc: cssVar("--acc", "#C2410C"), acc2: "#231C17", rule: "#E4DACB" };
    ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);
    if (tpl === "art") {
      ctx.strokeStyle = pal.rule; ctx.lineWidth = 6; ctx.strokeRect(48, 48, W - 96, H - 96);
      ctx.fillStyle = pal.acc2; ctx.globalAlpha = .9;
      ctx.beginPath(); ctx.moveTo(48, H - 300);
      for (var x = 48; x <= W - 48; x += 12) ctx.lineTo(x, H - 300 + Math.sin(x / 60) * 16);
      ctx.lineTo(W - 48, H - 48); ctx.lineTo(48, H - 48); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 4; ctx.lineCap = "round";
      for (var row = 0; row < 2; row++) {
        ctx.beginPath();
        for (var x2 = 70; x2 < W - 80; x2 += 60) { var yy = H - 240 + row * 52; ctx.moveTo(x2, yy); ctx.quadraticCurveTo(x2 + 15, yy - 12, x2 + 30, yy); }
        ctx.stroke();
      }
    } else if (tpl === "dark") {
      var g = ctx.createRadialGradient(W * .85, 0, 10, W * .85, 0, W);
      g.addColorStop(0, "rgba(255,133,71,.22)"); g.addColorStop(1, "rgba(255,133,71,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = pal.acc; ctx.fillRect(120, 150, 64, 8);
    }
    var top = 230, maxW = W - 240;
    ctx.fillStyle = pal.acc;
    ctx.font = "160px " + display;
    ctx.textBaseline = "alphabetic";
    if (tpl !== "min") ctx.fillText("“", 104, 270);
    var body = text.length > 160 ? text.slice(0, 158) + "……" : text;
    var size = body.length > 110 ? 46 : body.length > 60 ? 54 : 62;
    ctx.font = size + "px " + serif;
    ctx.fillStyle = pal.ink;
    var lines = wrapLines(ctx, body, maxW);
    var lh = size * 1.75;
    var limitY = tpl === "art" ? H - 420 : H - 330;
    var y = Math.max(top + 120, Math.min(top + 180, limitY - lines.length * lh));
    lines.forEach(function (ln) { if (y < limitY) ctx.fillText(ln, 120, y); y += lh; });
    ctx.fillStyle = tpl === "art" ? pal.ink : pal.sub;
    ctx.font = "34px " + serif;
    var src = "—— 《" + D.title + "》" + chName(n).replace("　", " ") + " · 第" + (p + 1) + "段";
    var sy = tpl === "art" ? H - 360 : H - 250;
    ctx.fillText(src, 120, sy);
    ctx.font = "28px " + serif;
    ctx.fillStyle = tpl === "art" ? "#FFFFFF" : pal.sub;
    ctx.globalAlpha = tpl === "art" ? 1 : .8;
    var wm = D.title + (D.series ? " · " + D.series : "");
    ctx.fillText(wm, tpl === "art" ? 120 : 120, H - (tpl === "art" ? 100 : 130));
    ctx.globalAlpha = 1;
    if (tpl !== "art") { ctx.fillStyle = pal.rule; ctx.fillRect(120, H - 190, W - 240, 2); }
  }
  function quoteCard(text, n, p) {
    text = String(text || "").trim();
    if (!text) return;
    var box = el("div", { class: "card-ed" });
    var chips = el("div", { class: "chips", role: "radiogroup", "aria-label": "模板" });
    var cv = el("canvas", { class: "card-cv", width: 1080, height: 1350, "aria-label": "金句卡片预览" });
    var tpl = R.get("cardTpl") || "art";
    TPLS.forEach(function (t) {
      var b = el("button", { type: "button", class: "chip", role: "radio", "aria-checked": t.id === tpl ? "true" : "false", "data-t": t.id, text: t.name });
      chips.appendChild(b);
    });
    var row = el("div", { class: "row" });
    var saveB = el("button", { class: "btn-s pri", type: "button", text: "保存图片" });
    var linkB = el("button", { class: "btn-s", type: "button", text: "复制分享链接" });
    row.appendChild(saveB); row.appendChild(linkB);
    var tip = el("p", { class: "tip", hidden: true });
    box.appendChild(chips); box.appendChild(cv); box.appendChild(row); box.appendChild(tip);
    R.sheet({ title: "金句卡片", body: box, cls: "wide" });
    function redraw() { drawCard(cv, text, n, p, tpl); }
    var fam = cssVar("--serif", "serif");
    if (document.fonts && document.fonts.load) {
      Promise.all([document.fonts.load("54px " + fam, text), document.fonts.load("34px " + fam, D.title)]).then(redraw, redraw);
    }
    redraw();
    chips.addEventListener("click", function (e) {
      var b = e.target.closest(".chip"); if (!b) return;
      tpl = b.getAttribute("data-t"); R.set("cardTpl", tpl);
      chips.querySelectorAll(".chip").forEach(function (c) { c.setAttribute("aria-checked", c === b ? "true" : "false"); });
      redraw();
    });
    linkB.addEventListener("click", function () { copyText(shareLink(n, p), "链接已复制"); });
    saveB.addEventListener("click", function () {
      var fname = D.title + "-第" + pad(n) + "章-第" + (p + 1) + "段.png";
      var fallback = function () {
        tip.hidden = false;
        tip.innerHTML = "";
        tip.appendChild(el("span", { text: "长按或右键下面的图片保存：" }));
        var img = el("img", { src: cv.toDataURL("image/png"), alt: "金句卡片", class: "card-img" });
        tip.appendChild(img);
      };
      if (!C.dl && !window.claude && cv.toBlob) {
        cv.toBlob(function (blob) {
          var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fname;
          document.body.appendChild(a); a.click(); a.remove(); R.toast("已保存");
        }, "image/png");
        return;
      }
      if (!C.dl || !cv.toBlob) { fallback(); return; }
      cv.toBlob(function (blob) {
        C.dl.save({ filename: fname, data: blob }).then(function (r) {
          if (r && r.status === "saved") R.toast("已保存");
        }, function (e) { if (!e || e.code !== "cancelled") fallback(); });
      }, "image/png");
    });
  }

  /* =====================================================================
   * 全文搜索
   * ===================================================================== */
  function openSearch(q0) {
    var box = el("div", { class: "find" });
    var form = el("form", { class: "find-f", role: "search" });
    var inp = el("input", { id: "findQ", type: "search", placeholder: "人名、词、一句话……", "aria-label": "搜索", autocomplete: "off" });
    var sel = el("select", { id: "findCh", "aria-label": "范围" });
    sel.appendChild(el("option", { value: "0", text: "全书" }));
    CH.forEach(function (c) { sel.appendChild(el("option", { value: String(c.n), text: chName(c.n) })); });
    var bookSel = el("select", { id: "findBook", "aria-label": "哪一本" });
    bookSel.appendChild(el("option", { value: "this", text: "《" + D.title + "》" }));
    (D.series_nav || []).forEach(function (b) { if (b.state !== "current") bookSel.appendChild(el("option", { value: "", disabled: true, text: "《" + b.title + "》（在它自己的页面里搜）" })); });
    form.appendChild(inp); form.appendChild(bookSel); form.appendChild(sel);
    var res = el("div", { class: "find-r", "aria-live": "polite" });
    box.appendChild(form); box.appendChild(res);
    var sh = R.sheet({ title: "全文搜索", body: box, cls: "wide top" });
    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    var t = 0;
    inp.addEventListener("input", function () { clearTimeout(t); t = setTimeout(run, 160); });
    sel.addEventListener("change", run);
    setTimeout(function () { inp.focus(); }, 60);
    if (q0) { inp.value = q0; }
    run();
    function run() {
      var q = inp.value.trim();
      res.innerHTML = "";
      if (!q) {
        var hint = el("div", { class: "find-hint" });
        hint.appendChild(el("p", { text: "试试搜：" }));
        var tags = el("div", { class: "chips" });
        ["船头朝里", "比海水浅一点", "收现", "阿宝", "汤圆", "补纸"].forEach(function (w) {
          var b = el("button", { type: "button", class: "chip", text: w });
          b.addEventListener("click", function () { inp.value = w; run(); });
          tags.appendChild(b);
        });
        hint.appendChild(tags);
        res.appendChild(hint);
        return;
      }
      var only = +sel.value;
      var who = PEOPLE.filter(function (p) { return p.aliases.some(function (a) { return a.indexOf(q) >= 0 || q.indexOf(a) >= 0; }); });
      if (who.length) {
        var pr = el("div", { class: "find-people" });
        who.slice(0, 4).forEach(function (p) {
          var b = el("button", { type: "button", class: "pchip" }, "<b>" + esc(p.name) + "</b><small>" + esc(p.role) + "</small>");
          b.addEventListener("click", function () { sh.close(); personCard(p.id); });
          pr.appendChild(b);
        });
        res.appendChild(pr);
      }
      var hits = [], total = 0, chs = {};
      CH.forEach(function (c) {
        if (only && c.n !== only) return;
        c.paras.forEach(function (t, i) {
          var k = t.indexOf(q);
          if (k < 0) return;
          var cnt = 0, j = k; while (j >= 0) { cnt++; j = t.indexOf(q, j + q.length); }
          total += cnt; chs[c.n] = 1;
          if (hits.length < 300) hits.push({ n: c.n, p: i, t: t, k: k });
        });
      });
      res.appendChild(el("p", { class: "find-sum", text: total ? "找到 " + total + " 处，在 " + Object.keys(chs).length + " 章里" + (hits.length >= 300 ? "（只列前 300 段）" : "") : "没有找到“" + q + "”" }));
      var ol = el("ol", { class: "find-list" });
      hits.forEach(function (h) {
        var start = Math.max(0, h.k - 36), end = Math.min(h.t.length, h.k + q.length + 60);
        var s = (start ? "…" : "") + h.t.slice(start, end) + (end < h.t.length ? "…" : "");
        var html = esc(s).split(esc(q)).join("<mark>" + esc(q) + "</mark>");
        var li = el("li");
        var a = el("a", { href: R.chHref(h.n, h.p) }, '<small>' + esc(chName(h.n)) + " · 第" + (h.p + 1) + "段</small><span>" + html + "</span>");
        a.addEventListener("click", function () { sh.close(); });
        li.appendChild(a);
        ol.appendChild(li);
      });
      res.appendChild(ol);
    }
  }
  var findBtn = document.getElementById("findBtn");
  if (findBtn) findBtn.addEventListener("click", function (e) { e.stopPropagation(); openSearch(); });
  document.addEventListener("keydown", function (e) {
    if ((e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey))) && !/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || "")) { e.preventDefault(); openSearch(); }
  });

  /* =====================================================================
   * 人物：卡片、出场、关系图
   * ===================================================================== */
  var occCache = {};
  function occurrences(id) {
    if (occCache[id]) return occCache[id];
    var p = PBY[id], out = [];
    if (!p) return out;
    var al = p.aliases.slice().sort(function (a, b) { return b.length - a.length; });
    CH.forEach(function (c) {
      c.paras.forEach(function (t, i) {
        for (var k = 0; k < al.length; k++) if (t.indexOf(al[k]) >= 0) { out.push({ n: c.n, p: i, a: al[k] }); break; }
      });
    });
    occCache[id] = out;
    return out;
  }
  function personCard(id) {
    var p = PBY[id];
    if (!p) return;
    var mr = R.maxRead();
    var occ = occurrences(id);
    var chs = {}; occ.forEach(function (o) { chs[o.n] = (chs[o.n] || 0) + 1; });
    var chList = Object.keys(chs).map(Number).sort(function (a, b) { return a - b; });
    var box = el("div", { class: "pcard" });
    var grp = GROUPS.filter(function (g) { return g.id === p.group; })[0];
    box.innerHTML = '<p class="pc-role">' + esc(p.role) + (grp ? '<span class="pc-grp g-' + esc(p.group) + '">' + esc(grp.name) + "</span>" : "") + "</p>" +
      (p.aliases.length > 1 ? '<p class="pc-alias">也叫：' + p.aliases.filter(function (a) { return a !== p.name; }).map(esc).join("、") + "</p>" : "") +
      '<p class="pc-intro">' + esc(p.intro) + "</p>" +
      (occ.length ? '<p class="pc-occ">出场：' + chList.length + " 章，" + occ.length + " 段。首次出现在" + esc(chName(occ[0].n)) + "</p>" : "");
    var row = el("div", { class: "row" });
    if (occ.length) {
      var first = el("a", { class: "btn-s pri", href: R.chHref(occ[0].n, occ[0].p), text: "跳到首次出场" });
      var all = el("button", { class: "btn-s", type: "button", text: "看全部出场段落" });
      row.appendChild(first); row.appendChild(all);
      first.addEventListener("click", function () { sh.close(); });
      all.addEventListener("click", function () { sh.close(); appearances(id); });
    }
    var tlBtn = el("a", { class: "btn-s", href: "#timeline-" + id, text: "在时间线上" });
    tlBtn.addEventListener("click", function () { sh.close(); });
    if (TL.some(function (e) { return e.who.indexOf(id) >= 0; })) row.appendChild(tlBtn);
    box.appendChild(row);

    var evs = (p.events || []).slice();
    if (evs.length) {
      box.appendChild(el("h3", { text: "关键事件" }));
      var ul = el("ul", { class: "pc-ev" });
      var hidden = 0;
      evs.forEach(function (ev) {
        var li = el("li");
        if (ev.ch > mr) { li.className = "spoil"; hidden++; }
        li.innerHTML = '<a href="' + R.chHref(ev.ch) + '"><small>' + esc(chShort(ev.ch)) + "</small>" + esc(ev.t) + "</a>";
        li.querySelector("a").addEventListener("click", function (e) {
          if (li.classList.contains("spoil")) { e.preventDefault(); li.classList.remove("spoil"); return; }
          sh.close();
        });
        ul.appendChild(li);
      });
      box.appendChild(ul);
      if (hidden) box.appendChild(el("p", { class: "tip", text: "模糊的 " + hidden + " 条在你还没读到的章节里，点一下才显示。" }));
    }
    var rels = [];
    (p.rel || []).forEach(function (r) { rels.push({ to: r.to, label: r.label, ch: r.ch }); });
    PEOPLE.forEach(function (o) { (o.rel || []).forEach(function (r) { if (r.to === id) rels.push({ to: o.id, label: r.label, ch: r.ch }); }); });
    if (rels.length) {
      box.appendChild(el("h3", { text: "关系" }));
      var ul2 = el("ul", { class: "pc-rel" });
      rels.forEach(function (r) {
        var o = PBY[r.to]; if (!o) return;
        var li = el("li", { class: r.ch > mr ? "spoil" : "" });
        var b = el("button", { type: "button" }, "<b>" + esc(o.name) + "</b><span>" + esc(r.label) + "</span>");
        b.addEventListener("click", function () { if (li.classList.contains("spoil")) { li.classList.remove("spoil"); return; } personCard(o.id); });
        li.appendChild(b); ul2.appendChild(li);
      });
      box.appendChild(ul2);
    }
    var sh = R.sheet({ title: p.name, body: box });
  }
  function appearances(id) {
    var p = PBY[id], occ = occurrences(id);
    var box = el("div", { class: "find" });
    var mr = R.maxRead();
    box.appendChild(el("p", { class: "find-sum", text: p.name + " 一共在 " + occ.length + " 段里出现。" + (occ.some(function (o) { return o.n > mr; }) ? "还没读到的章节已折起。" : "") }));
    var cur = 0, ol = null, det = null;
    occ.forEach(function (o) {
      if (o.n !== cur) {
        cur = o.n;
        det = el("details", { class: "occ-ch" });
        if (o.n <= mr) det.open = o.n === occ[0].n || o.n === R.current().ch;
        det.appendChild(el("summary", { text: chName(o.n) + "（" + occ.filter(function (x) { return x.n === o.n; }).length + "）" + (o.n > mr ? " · 还没读到" : "") }));
        ol = el("ol", { class: "find-list" });
        det.appendChild(ol); box.appendChild(det);
      }
      var t = paraText(o.n, o.p), k = t.indexOf(o.a);
      var start = Math.max(0, k - 30), end = Math.min(t.length, k + o.a.length + 50);
      var s = (start ? "…" : "") + t.slice(start, end) + (end < t.length ? "…" : "");
      var li = el("li");
      var a = el("a", { href: R.chHref(o.n, o.p) }, "<small>第" + (o.p + 1) + "段</small><span>" + esc(s).split(esc(o.a)).join("<mark>" + esc(o.a) + "</mark>") + "</span>");
      a.addEventListener("click", function () { sh.close(); });
      li.appendChild(a); ol.appendChild(li);
    });
    var sh = R.sheet({ title: p.name + " · 全部出场", body: box, cls: "wide" });
  }
  R.person = personCard;

  var visP = null, graphRedraw = null;
  R.on("tone", function () { if (graphRedraw) graphRedraw(); });
  R.on("leave", function () { graphRedraw = null; });
  function loadVis() {
    if (window.vis && window.vis.Network) return Promise.resolve(window.vis);
    if (visP) return visP;
    visP = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/vis-network@9.1.9/standalone/umd/vis-network.min.js";
      s.onload = function () { window.vis ? res(window.vis) : rej(); };
      s.onerror = rej;
      document.head.appendChild(s);
    });
    return visP;
  }
  if (PEOPLE.length) R.view("people", {
    title: "人物",
    render: function (box) {
      var mr = R.maxRead();
      var spoil = false;
      box.innerHTML = '<header class="vw-h"><p class="kicker">' + esc(D.title) + '</p><h1>人物</h1><p class="lede">点人名看卡片。关系图可以拖动、缩放；还没读到的关系先藏着。</p></header>';
      var tools = el("div", { class: "vw-tools" });
      var sp = el("label", { class: "tog" }, '<input type="checkbox" id="spoilAll"> 显示全部关系（含剧透）');
      tools.appendChild(sp);
      box.appendChild(tools);
      var graph = el("div", { class: "graph", id: "relGraph", role: "img", "aria-label": "人物关系图" });
      graph.appendChild(el("p", { class: "graph-wait", text: "关系图加载中……" }));
      box.appendChild(graph);
      GROUPS.forEach(function (g) {
        var ps = PEOPLE.filter(function (p) { return p.group === g.id; });
        if (!ps.length) return;
        box.appendChild(el("h2", { class: "grp-h g-" + g.id, text: g.name }));
        var grid = el("div", { class: "pgrid" });
        ps.forEach(function (p) {
          var occ = occurrences(p.id);
          var b = el("button", { type: "button", class: "pchip g-" + p.group }, "<b>" + esc(p.name) + "</b><small>" + esc(p.role) + "</small><em>" + (occ.length ? "出场 " + occ.length + " 段" : "") + "</em>");
          b.addEventListener("click", function () { personCard(p.id); });
          grid.appendChild(b);
        });
        box.appendChild(grid);
      });
      var net = null;
      function draw() {
        loadVis().then(function (vis) {
          var cs = getComputedStyle(document.documentElement);
          var v = function (n, d) { return (cs.getPropertyValue(n) || "").trim() || d; };
          var gcol = { now: v("--acc", "#FF6A2B"), mg: v("--alt", "#4D8EF7"), old: v("--ok", "#23B58A") };
          var used = {};
          var edges = [];
          PEOPLE.forEach(function (p) {
            (p.rel || []).forEach(function (r) {
              if (!spoil && r.ch > mr) return;
              if (!PBY[r.to]) return;
              used[p.id] = used[r.to] = 1;
              edges.push({ from: p.id, to: r.to, label: r.label, font: { color: v("--ink-2", "#555"), strokeWidth: 3, strokeColor: v("--bg", "#fff"), size: 12, face: v("--sans", "sans-serif") }, color: { color: v("--rule", "#ccc"), highlight: v("--acc", "#f60") }, width: 1.5 });
            });
          });
          var nodes = PEOPLE.filter(function (p) {
            var first = occurrences(p.id)[0];
            return spoil || used[p.id] || (first && first.n <= mr);
          }).map(function (p) {
            var big = Math.min(36, 14 + Math.sqrt(occurrences(p.id).length) * 1.4);
            return { id: p.id, label: p.name, shape: "dot", size: big, color: { background: gcol[p.group] || gcol.now, border: v("--hard", "#333"), highlight: { background: v("--acc2", "#f39"), border: v("--hard", "#333") } }, borderWidth: 2, font: { color: v("--ink", "#222"), size: 15, face: v("--serif", "serif"), strokeWidth: 4, strokeColor: v("--bg", "#fff") } };
          });
          graph.innerHTML = "";
          if (net) net.destroy();
          net = new vis.Network(graph, { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) }, {
            physics: { solver: "forceAtlas2Based", forceAtlas2Based: { gravitationalConstant: -60, springLength: 120 }, stabilization: { iterations: 200 } },
            interaction: { hover: true, tooltipDelay: 150 }, edges: { smooth: { type: "continuous" } }
          });
          net.on("click", function (e) { if (e.nodes && e.nodes[0]) personCard(e.nodes[0]); });
        }, function () {
          graph.innerHTML = "";
          graph.appendChild(el("p", { class: "graph-wait", text: "关系图需要联网加载，现在没加载上。下面的名单一样可以点。" }));
        });
      }
      draw();
      sp.querySelector("input").addEventListener("change", function (e) { spoil = e.target.checked; draw(); });
      graphRedraw = function () { if (net && document.getElementById("relGraph")) draw(); };
    }
  });

  /* =====================================================================
   * 时间线
   * ===================================================================== */
  function tlItem(ev, mr, clickable) {
    var li = el("li", { class: "tl-ev era-" + ev.era + (ev.ch > mr ? " spoil" : "") });
    var whoHtml = ev.who.map(function (w) { return PBY[w] ? '<span class="tl-who">' + esc(PBY[w].name) + "</span>" : ""; }).join("");
    li.innerHTML = '<span class="tl-d">' + esc(ev.d) + '</span><div class="tl-c"><a class="tl-t" href="' + R.chHref(ev.ch) + '">' + esc(ev.t) + "<small>" + esc(chShort(ev.ch)) + "</small></a>" +
      '<p class="tl-s">' + esc(ev.s) + "</p>" + (whoHtml ? '<p class="tl-w">' + whoHtml + "</p>" : "") + (ev.ch > mr ? '<span class="spoil-tag">剧透 · 点开</span>' : "") + "</div>";
    li.addEventListener("click", function (e) {
      if (li.classList.contains("spoil")) { e.preventDefault(); li.classList.remove("spoil"); }
    });
    void clickable;
    return li;
  }
  if (TL.length) R.view("timeline", {
    title: "时间线",
    render: function (box, arg) {
      var mr = R.maxRead();
      box.innerHTML = '<header class="vw-h"><p class="kicker">' + esc(D.title) + '</p><h1>时间线</h1><p class="lede">从嘉靖年间的一页账，到民国的一条船，再到台风夜的一只冷箱。还没读到的事先模糊着，点一下才显示。</p></header>';
      var tools = el("div", { class: "vw-tools" });
      var who = el("select", { id: "tlWho", "aria-label": "按人物" });
      who.appendChild(el("option", { value: "", text: "所有人物" }));
      PEOPLE.forEach(function (p) { if (TL.some(function (e) { return e.who.indexOf(p.id) >= 0; })) who.appendChild(el("option", { value: p.id, text: p.name })); });
      var book = el("select", { id: "tlBook", "aria-label": "按小说" });
      book.appendChild(el("option", { value: "this", text: "《" + D.title + "》" }));
      (D.series_nav || []).forEach(function (b) { if (b.state !== "current") book.appendChild(el("option", { value: "", disabled: true, text: "《" + b.title + "》（还没接入时间线）" })); });
      var eraSel = el("select", { id: "tlEra", "aria-label": "按年代" });
      eraSel.appendChild(el("option", { value: "", text: "所有年代" }));
      ERAS.forEach(function (e) { eraSel.appendChild(el("option", { value: e.id, text: e.name })); });
      tools.appendChild(book); tools.appendChild(who); tools.appendChild(eraSel);
      box.appendChild(tools);
      var list = el("div", { class: "tl" });
      box.appendChild(list);
      if (arg && PBY[arg]) who.value = arg;
      function draw() {
        list.innerHTML = "";
        var w = who.value, er = eraSel.value;
        var evs = TL.filter(function (e) { return (!w || e.who.indexOf(w) >= 0) && (!er || e.era === er); })
          .sort(function (a, b) { return a.k < b.k ? -1 : a.k > b.k ? 1 : 0; });
        ERAS.forEach(function (era) {
          var es = evs.filter(function (e) { return e.era === era.id; });
          if (!es.length) return;
          list.appendChild(el("h2", { class: "tl-era era-" + era.id, text: era.name }));
          var ol = el("ol", { class: "tl-list" });
          es.forEach(function (e) { ol.appendChild(tlItem(e, mr)); });
          list.appendChild(ol);
        });
        if (!evs.length) list.appendChild(el("p", { class: "empty", text: "没有符合条件的事件。" }));
      }
      who.addEventListener("change", draw); eraSel.addEventListener("change", draw);
      draw();
    }
  });

  /* =====================================================================
   * 章节页上的东西：前情提要、本章大事、评论、段落气泡
   * ===================================================================== */
  R.on("chapter", function (n, view) {
    paintChapter(n);
    var c = CH[n - 1];
    var pre = view.querySelector('[data-slot="pre"]');
    var post = view.querySelector('[data-slot="post"]');
    if (n > 1 && pre) addLive(function () { renderRecap(pre, n); });
    // 本章大事
    var evs = TL.filter(function (e) { return e.ch === n; });
    if (evs.length && post) {
      var sec = el("section", { class: "ch-tl", "aria-label": "本章在时间线上" });
      sec.appendChild(el("h2", {}, '本章大事<a href="#timeline">看完整时间线 ›</a>'));
      var ol = el("ol", { class: "tl-list mini" });
      evs.sort(function (a, b) { return a.k < b.k ? -1 : 1; }).forEach(function (e) { ol.appendChild(tlItem(e, 999)); });
      sec.appendChild(ol);
      post.appendChild(sec);
    }
    if (post && SOCIAL) {
      var cm = el("section", { class: "cmts", id: "comments", "aria-label": "评论" });
      post.appendChild(cm);
      var sort = R.get("cmSort") || "new";
      addLive(function () { renderChapterComments(cm, n, sort, function (s) { sort = s; R.set("cmSort", s); }); });
    }
    if (SOCIAL) addLive(function () { paintBubbles(n); });
    void c;
  });

  function renderRecap(pre, n) {
    var text = (S.recaps && S.recaps[String(n)]) || CH[n - 1].recap || "";
    pre.innerHTML = "";
    if (!text && !C.owner && !C.sample) return;
    var det = el("details", { class: "recap" });
    var key = "recapOpen";
    det.open = R.get(key) === "1";
    det.appendChild(el("summary", {}, "<span>前情提要</span><small>" + esc(chName(n - 1)) + "</small>"));
    var body = el("div", { class: "recap-b" });
    if (text) body.appendChild(el("p", { text: text }));
    else body.appendChild(el("p", { class: "tip", text: "这一章还没有前情提要。" }));
    var row = el("div", { class: "row" });
    if (!text && C.sample) {
      var ai = el("button", { class: "btn-s", type: "button", text: "让 Claude 概括上一章" });
      ai.addEventListener("click", function () {
        ai.disabled = true; ai.textContent = "正在概括……";
        var prev = CH[n - 2].paras.join("\n");
        C.sample([{ role: "user", content: "下面是小说《" + D.title + "》" + chName(n - 1) + "的全文。请用 120 字以内的中文写一段“前情提要”，只讲发生了什么，不评价，不剧透后面的章节，不用标题和列表：\n\n" + prev }], { modelTier: "quick" })
          .then(function (r) { body.firstChild.textContent = (r && r.text || "").trim(); body.firstChild.className = ""; ai.remove(); },
            function () { ai.disabled = false; ai.textContent = "没成功，再试一次"; });
      });
      row.appendChild(ai);
    }
    if (C.owner) {
      var ed = el("a", { class: "btn-s", href: "#admin-recaps", text: "改前情提要" });
      row.appendChild(ed);
    }
    if (row.firstChild) body.appendChild(row);
    det.appendChild(body);
    det.addEventListener("toggle", function () { R.set(key, det.open ? "1" : "0"); });
    pre.appendChild(det);
  }

  function paraComments(n, p) { return allComments().filter(function (c) { return c.ch === n && c.p === p && !c.re; }); }
  function paintBubbles(n) {
    var a = chapterArticle();
    if (!a) return;
    var layer = a.querySelector(".bub-layer");
    if (!layer) { layer = el("div", { class: "bub-layer", "aria-hidden": "false" }); a.appendChild(layer); watchArticle(a, n); }
    layer.innerHTML = "";
    var cnt = {};
    allComments().forEach(function (c) { if (c.ch === n && c.p != null) cnt[c.p] = (cnt[c.p] || 0) + 1; });
    Object.keys(cnt).forEach(function (p) {
      var pe = a.querySelector('[data-p="' + p + '"]');
      if (!pe) return;
      var b = el("button", { type: "button", class: "bub", "data-p": p, "aria-label": "第" + (+p + 1) + "段有 " + cnt[p] + " 条评论", text: String(cnt[p]) });
      b.addEventListener("click", function (e) { e.stopPropagation(); paraThread(n, +p); });
      layer.appendChild(b);
    });
    placeBubbles(a);
  }
  function placeBubbles(a) {
    var layer = a.querySelector(".bub-layer"); if (!layer) return;
    var top0 = a.getBoundingClientRect().top;
    layer.querySelectorAll(".bub").forEach(function (b) {
      var pe = a.querySelector('[data-p="' + b.getAttribute("data-p") + '"]');
      if (!pe) return;
      b.style.top = Math.round(pe.getBoundingClientRect().top - top0) + "px";
    });
  }
  function watchArticle(a) {
    if ("ResizeObserver" in window) { var ro = new ResizeObserver(function () { placeBubbles(a); }); ro.observe(a); }
  }

  function commentItem(c, map, likes, opts) {
    var li = el("li", { class: "cm" + (c.re ? " re" : ""), id: "c-" + c.id });
    var head = el("div", { class: "cm-h" });
    head.appendChild(personTag(c.uid, map));
    if (c.to && map[c.to] && c.re) head.appendChild(el("span", { class: "cm-to", text: "回复 " + (map[c.to].name || "一位读者") }));
    head.appendChild(el("time", { text: ago(c.ts) }));
    li.appendChild(head);
    if (opts.showWhere && c.p != null) li.appendChild(el("a", { class: "cm-where", href: R.chHref(c.ch, c.p), text: chShort(c.ch) + "第" + (c.p + 1) + "段：" + snip(paraText(c.ch, c.p), 26) }));
    else if (opts.showWhere) li.appendChild(el("a", { class: "cm-where", href: R.chHref(c.ch) + "", text: chName(c.ch) }));
    li.appendChild(el("p", { class: "cm-t", text: c.text }));
    var acts = el("div", { class: "cm-a" });
    var mine = myDoc() && (myDoc().likes || []).indexOf(c.id) >= 0;
    var lk = el("button", { type: "button", class: "lk" + (mine ? " on" : ""), "aria-pressed": mine ? "true" : "false", text: "赞" + (likes[c.id] ? " " + likes[c.id] : "") });
    lk.addEventListener("click", function () {
      writeMine(function (d) {
        var i = d.likes.indexOf(c.id);
        if (i >= 0) d.likes.splice(i, 1); else d.likes.push(c.id);
      });
    });
    acts.appendChild(lk);
    if (opts.reply) {
      var rp = el("button", { type: "button", text: "回复" });
      rp.addEventListener("click", function () { opts.reply(c); });
      acts.appendChild(rp);
    }
    if (c.uid === C.uid || C.owner) {
      var del = el("button", { type: "button", class: "del", text: "删除" });
      del.addEventListener("click", function () {
        if (del.getAttribute("data-sure") !== "1") { del.setAttribute("data-sure", "1"); del.textContent = "确定删除？"; setTimeout(function () { del.removeAttribute("data-sure"); del.textContent = "删除"; }, 3000); return; }
        deleteComment(c);
      });
      acts.appendChild(del);
    }
    li.appendChild(acts);
    return li;
  }
  function deleteComment(c) {
    if (c.uid === C.uid) {
      writeMine(function (d) { d.comments = d.comments.filter(function (x) { return x.id !== c.id && x.re !== c.id; }); });
      return;
    }
    if (!C.owner || !C.db) return;
    var other = S.users[c.uid]; if (!other) return;
    var arr = (other.comments || []).filter(function (x) { return x.id !== c.id && x.re !== c.id; });
    C.db.doc("u/" + c.uid).update({ comments: arr }).then(function () { R.toast("已删除"); }, writeErr);
  }
  function composer(opts) {
    var f = el("form", { class: "cm-f" });
    var st = sharedState();
    var ta = el("textarea", { id: opts.id || "cmTa", rows: 3, maxlength: 1000, placeholder: opts.placeholder || "说点什么……", "aria-label": opts.label || "写评论" });
    var row = el("div", { class: "row" });
    var to = el("span", { class: "cm-replying", hidden: true });
    var cancel = el("button", { type: "button", class: "btn-s ghost", text: "不回复了", hidden: true });
    var send = el("button", { type: "submit", class: "btn-s pri", text: opts.send || "发布" });
    row.appendChild(to); row.appendChild(cancel); row.appendChild(send);
    f.appendChild(ta); f.appendChild(row);
    if (st !== "ok") {
      ta.disabled = true; send.disabled = true;
      ta.placeholder = sharedNote();
      if (st === "anon" && AUTH) { send.hidden = true; row.appendChild(loginBtn()); }
    }
    var replyTo = null;
    f.setReply = function (c, nm) { replyTo = c; to.hidden = false; to.textContent = "回复 " + nm; cancel.hidden = false; ta.focus(); };
    cancel.addEventListener("click", function () { replyTo = null; to.hidden = true; cancel.hidden = true; });
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var t = ta.value.trim();
      if (!t) { ta.focus(); return; }
      send.disabled = true;
      var c = { id: "c" + uid8(), ch: opts.ch, p: opts.p == null ? null : opts.p, text: t, ts: Date.now(), re: replyTo ? (replyTo.re || replyTo.id) : null, to: replyTo ? replyTo.uid : null };
      ta.value = "";
      writeMine(function (d) { d.comments.push(c); }).then(function (ok) {
        send.disabled = false;
        if (ok) { replyTo = null; to.hidden = true; cancel.hidden = true; R.toast("已发布"); }
        else { var cur = document.getElementById(ta.id) || ta; if (!cur.value) cur.value = t; }
      });
    });
    return f;
  }
  function threadList(roots, all, map, likes, f, showWhere) {
    var ul = el("ul", { class: "cm-list" });
    roots.forEach(function (c) {
      ul.appendChild(commentItem(c, map, likes, { reply: function (x) { f.setReply(x, (map[x.uid] && map[x.uid].name) || "这位读者"); }, showWhere: showWhere }));
      all.filter(function (r) { return r.re === c.id; }).sort(function (a, b) { return a.ts - b.ts; }).forEach(function (r) {
        ul.appendChild(commentItem(r, map, likes, { reply: function (x) { f.setReply(x, (map[x.uid] && map[x.uid].name) || "这位读者"); } }));
      });
    });
    return ul;
  }
  function renderChapterComments(box, n, sort, setSort) {
    var all = allComments().filter(function (c) { return c.ch === n; });
    var roots = all.filter(function (c) { return c.p == null && !c.re; });
    var paraCnt = all.filter(function (c) { return c.p != null; }).length;
    var likes = likeCounts();
    if (sort === "hot") roots.sort(function (a, b) { return (likes[b.id] || 0) - (likes[a.id] || 0) || b.ts - a.ts; });
    else roots.sort(function (a, b) { return b.ts - a.ts; });
    var ids = all.map(function (c) { return c.uid; }).concat(all.map(function (c) { return c.to; }).filter(Boolean));
    var focusId = document.activeElement && document.activeElement.id;
    var draft = box.querySelector("textarea") ? box.querySelector("textarea").value : "";
    names(ids.filter(function (x, i, a) { return a.indexOf(x) === i; })).then(function (map) {
      box.innerHTML = "";
      var h = el("div", { class: "cm-head" });
      h.appendChild(el("h2", { text: "评论" + (roots.length ? " · " + roots.length : "") }));
      var tabs = el("div", { class: "seg", role: "tablist" });
      [["new", "最新"], ["hot", "最热"]].forEach(function (x) {
        var b = el("button", { type: "button", role: "tab", "aria-selected": sort === x[0] ? "true" : "false", text: x[1] });
        b.addEventListener("click", function () { setSort(x[0]); renderChapterComments(box, n, x[0], setSort); });
        tabs.appendChild(b);
      });
      h.appendChild(tabs);
      box.appendChild(h);
      if (paraCnt) box.appendChild(el("p", { class: "tip", text: "正文里还有 " + paraCnt + " 条段落评论，看段落右边的小气泡。" }));
      var f = composer({ ch: n, p: null, id: "cmTa" + n, placeholder: "读完这一章，想说点什么？" });
      if (draft) f.querySelector("textarea").value = draft;
      box.appendChild(f);
      if (roots.length) box.appendChild(threadList(roots, all.filter(function (c) { return c.p == null; }), map, likes, f));
      else if (sharedState() === "ok") box.appendChild(el("p", { class: "empty", text: "还没有人说话。你可以是第一个。" }));
      if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus({ preventScroll: true });
    });
  }
  function paraThread(n, p) {
    var box = el("div", { class: "pthread" });
    box.appendChild(el("blockquote", { class: "q", text: snip(paraText(n, p), 120) }));
    var inner = el("div");
    box.appendChild(inner);
    var sh = R.sheet({ title: chShort(n) + "第" + (p + 1) + "段", body: box });
    var f = composer({ ch: n, p: p, id: "pcTa", placeholder: "就这一段说点什么……" });
    function draw() {
      if (!box.parentNode) return;
      var all = allComments().filter(function (c) { return c.ch === n && c.p === p; });
      var roots = all.filter(function (c) { return !c.re; }).sort(function (a, b) { return a.ts - b.ts; });
      var likes = likeCounts();
      names(all.map(function (c) { return c.uid; }).concat(all.map(function (c) { return c.to; }).filter(Boolean))).then(function (map) {
        inner.innerHTML = "";
        if (roots.length) inner.appendChild(threadList(roots, all, map, likes, f));
        else inner.appendChild(el("p", { class: "empty", text: sharedState() === "ok" ? "这一段还没有评论。" : sharedNote() }));
        inner.appendChild(f);
      });
    }
    live.push(draw);
    draw();
    void sh;
  }

  /* =====================================================================
   * 读后感
   * ===================================================================== */
  if (SOCIAL) R.view("reviews", {
    title: "读后感",
    render: function (box) {
      box.innerHTML = '<header class="vw-h"><p class="kicker">' + esc(D.title) + '</p><h1>读后感</h1><p class="lede">读完了，或者读到一半，写几句给后来的人看。每人一篇，可以改。</p></header>';
      var mine = el("section", { class: "rv-mine" });
      var list = el("section", { class: "rv-list" });
      box.appendChild(mine); box.appendChild(list);
      var draft = null;
      addLive(function () {
        var st = sharedState();
        var my = myDoc() && myDoc().review;
        mine.innerHTML = "";
        var f = el("form", { class: "cm-f" });
        var ta = el("textarea", { id: "rvTa", rows: 6, maxlength: 4000, placeholder: st === "ok" ? "我的读后感……" : sharedNote(), "aria-label": "我的读后感" });
        ta.value = draft != null ? draft : (my && my.text) || "";
        ta.addEventListener("input", function () { draft = ta.value; });
        if (st !== "ok") ta.disabled = true;
        var row = el("div", { class: "row" });
        if (st === "anon" && AUTH) row.appendChild(loginBtn());
        row.appendChild(el("span", { class: "tip", text: "已读 " + doneList().length + " / " + N + " 章" }));
        if (my) { var dl = el("button", { type: "button", class: "btn-s ghost", text: "删除我的读后感" }); row.appendChild(dl); dl.addEventListener("click", function () { draft = null; writeMine(function (d) { d.review = null; }); }); }
        var sv = el("button", { type: "submit", class: "btn-s pri", text: my ? "更新" : "发布", disabled: st !== "ok" });
        row.appendChild(sv);
        f.appendChild(ta); f.appendChild(row);
        f.addEventListener("submit", function (e) {
          e.preventDefault();
          var t = ta.value.trim(); if (!t) return;
          writeMine(function (d) { d.review = { text: t, ts: Date.now(), done: doneList().length }; }).then(function (ok) { if (ok) { draft = null; R.toast("读后感已发布"); } });
        });
        mine.appendChild(f);
        var ids = Object.keys(S.users).filter(function (u) { return S.users[u].review && S.users[u].review.text; });
        ids.sort(function (a, b) { return S.users[b].review.ts - S.users[a].review.ts; });
        names(ids).then(function (map) {
          list.innerHTML = "";
          list.appendChild(el("h2", { text: ids.length ? ids.length + " 篇读后感" : "" }));
          if (!ids.length) list.appendChild(el("p", { class: "empty", text: st === "ok" ? "还没有人写。" : sharedNote() }));
          ids.forEach(function (u) {
            var rv = S.users[u].review;
            var art = el("article", { class: "rv" });
            var h = el("div", { class: "cm-h" });
            h.appendChild(personTag(u, map));
            h.appendChild(el("time", { text: ago(rv.ts) + (rv.done ? " · 当时读了 " + rv.done + " 章" : "") }));
            art.appendChild(h);
            rv.text.split(/\n+/).forEach(function (para) { art.appendChild(el("p", { text: para })); });
            if (C.owner && u !== C.uid) {
              var del = el("button", { type: "button", class: "btn-s ghost", text: "删除" });
              del.addEventListener("click", function () { C.db.doc("u/" + u).update({ review: null }).then(function () { R.toast("已删除"); }, writeErr); });
              art.appendChild(del);
            }
            list.appendChild(art);
          });
        });
      });
    }
  });

  /* =====================================================================
   * 我的书房 / 读者主页
   * ===================================================================== */
  function statTiles(items) {
    var d = el("dl", { class: "tiles" });
    items.forEach(function (x) { var w = el("div"); w.appendChild(el("dt", { text: x[0] })); w.appendChild(el("dd", { text: x[1] })); d.appendChild(w); });
    return d;
  }
  R.view("shelf", {
    title: "我的书房",
    render: function (box) {
      var head = el("header", { class: "vw-h me-h" });
      box.appendChild(head);
      function drawHead() {
        head.innerHTML = "";
        var me = C.me;
        if (me && me.avatarUrl) head.appendChild(el("img", { class: "av", src: me.avatarUrl, alt: "", width: 64, height: 64 }));
        var t = el("div");
        t.appendChild(el("p", { class: "kicker", text: D.title + " · 我的书房" }));
        t.appendChild(el("h1", { text: (me && me.name) || "我的书房" }));
        var d = new Date(L.first);
        t.appendChild(el("p", { class: "lede", text: "第一次打开这本书是 " + d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日。划线、批注、书签都存在这台设备上。" }));
        head.appendChild(t);
      }
      addLive(drawHead);
      var done = doneList();
      box.appendChild(statTiles([
        ["读完", done.length + " / " + N + " 章"],
        ["阅读时长", dur(totalTime())],
        ["连读", streak() + " 天"],
        ["划线", L.hl.length + " 条"]
      ]));
      var bar = el("div", { class: "chbar", "aria-label": "每章读完了没有" });
      CH.forEach(function (c) {
        var a = el("a", { href: R.chHref(c.n), class: (done.indexOf(c.n) >= 0 ? "on" : "") + (c.era ? " era" : ""), title: chName(c.n), text: String(c.n) });
        bar.appendChild(a);
      });
      box.appendChild(bar);

      var pv = el("section", { class: "privacy" });
      if (SOCIAL) box.appendChild(pv);
      if (SOCIAL) addLive(function () {
        pv.innerHTML = "<h2>公开设置</h2>";
        var st = sharedState();
        if (st !== "ok") { pv.appendChild(el("p", { class: "tip", text: sharedNote() })); if (st === "anon" && AUTH) pv.appendChild(loginBtn()); return; }
        [["pubHl", "公开我的划线", "别人能在你的主页看到，也会算进“热门划线”。批注不公开。"],
         ["pubStats", "公开我的阅读进度", "别人能看到你读完了几章、读了多久。"]].forEach(function (x) {
          var lab = el("label", { class: "tog" });
          var cb = el("input", { type: "checkbox", id: "pv-" + x[0] });
          cb.checked = !!L.prefs[x[0]];
          lab.appendChild(cb); lab.appendChild(el("span", {}, "<b>" + x[1] + "</b><small>" + x[2] + "</small>"));
          cb.addEventListener("change", function () {
            L.prefs[x[0]] = cb.checked; saveL("prefs");
            if (x[0] === "pubHl") syncPublicHl(); else pushPublicStats();
          });
          pv.appendChild(lab);
        });
        if (SAFE_ID.test(C.uid)) pv.appendChild(el("a", { class: "btn-s", href: "#reader-" + C.uid, text: "看看别人眼里的我" }));
        if (C.owner) pv.appendChild(el("a", { class: "btn-s pri", href: "#admin", text: "作者后台" }));
        if (AUTH && AUTH.loggedIn()) {
          var rn = el("button", { type: "button", class: "btn-s", text: "改昵称" }); rn.addEventListener("click", function () { AUTH.rename(); });
          var lo = el("button", { type: "button", class: "btn-s ghost", text: "退出登录" }); lo.addEventListener("click", function () { AUTH.logout(); });
          pv.appendChild(rn); pv.appendChild(lo);
        }
      });

      var tabs = el("div", { class: "seg big", role: "tablist" });
      var pane = el("div", { class: "pane" });
      var TAB = SOCIAL ? [["hl", "划线与批注"], ["bm", "书签"], ["cm", "我的评论"]] : [["hl", "划线与批注"], ["bm", "书签"]];
      var curTab = R.get("shelfTab") || "hl";
      if (!SOCIAL && curTab === "cm") curTab = "hl";
      TAB.forEach(function (x) {
        var b = el("button", { type: "button", role: "tab", "aria-selected": x[0] === curTab ? "true" : "false", text: x[1] });
        b.addEventListener("click", function () { curTab = x[0]; R.set("shelfTab", curTab); tabs.querySelectorAll("button").forEach(function (y) { y.setAttribute("aria-selected", y === b ? "true" : "false"); }); drawPane(); });
        tabs.appendChild(b);
      });
      box.appendChild(tabs); box.appendChild(pane);
      var chFilter = "0";
      function filterSel() {
        var s = el("select", { id: "shelfCh", "aria-label": "按章筛选" });
        s.appendChild(el("option", { value: "0", text: "所有章节" }));
        CH.forEach(function (c) { s.appendChild(el("option", { value: String(c.n), text: chName(c.n) })); });
        s.value = chFilter;
        s.addEventListener("change", function () { chFilter = s.value; drawPane(); });
        return s;
      }
      function drawPane() {
        pane.innerHTML = "";
        if (curTab === "cm") {
          var mine = (myDoc() && myDoc().comments) || [];
          if (!mine.length) { pane.appendChild(el("p", { class: "empty", text: sharedState() === "ok" ? "你还没有发过评论。" : sharedNote() })); return; }
          var likes = likeCounts();
          var map = {}; map[C.uid] = C.me || {};
          var ul = el("ul", { class: "cm-list" });
          mine.slice().sort(function (a, b) { return b.ts - a.ts; }).forEach(function (c) { var x = clone(c); x.uid = C.uid; ul.appendChild(commentItem(x, map, likes, { showWhere: true })); });
          pane.appendChild(ul);
          return;
        }
        var tools = el("div", { class: "vw-tools" });
        tools.appendChild(filterSel());
        pane.appendChild(tools);
        var f = +chFilter;
        var items = (curTab === "hl" ? L.hl : L.bm).filter(function (x) { return !f || x.ch === f; })
          .slice().sort(function (a, b) { return a.ch - b.ch || a.p - b.p || (a.s || 0) - (b.s || 0); });
        if (!items.length) { pane.appendChild(el("p", { class: "empty", text: curTab === "hl" ? "还没有划线。在正文里选中一句话就能划。" : "还没有书签。点一下正文里的段落就能加。" })); return; }
        var ol = el("ol", { class: "find-list shelf-list" });
        items.forEach(function (x) {
          var li = el("li");
          var text = curTab === "hl" ? x.t : snip(paraText(x.ch, x.p), 80);
          var a = el("a", { href: R.chHref(x.ch, x.p) }, "<small>" + esc(chName(x.ch)) + " · 第" + (x.p + 1) + "段</small><span>" + esc(text) + "</span>" + (x.note ? '<em class="note-show">' + esc(x.note) + "</em>" : ""));
          li.appendChild(a);
          var acts = el("div", { class: "cm-a" });
          if (curTab === "hl") {
            var ne = el("button", { type: "button", text: x.note ? "改批注" : "写批注" }); ne.addEventListener("click", function () { noteEditor(x); });
            var cd = el("button", { type: "button", text: "金句卡" }); cd.addEventListener("click", function () { quoteCard(x.t, x.ch, x.p); });
            var dl = el("button", { type: "button", class: "del", text: "删除" }); dl.addEventListener("click", function () { delHl(x.id); drawPane(); });
            acts.appendChild(ne); acts.appendChild(cd); acts.appendChild(dl);
          } else {
            var db = el("button", { type: "button", class: "del", text: "删除书签" });
            db.addEventListener("click", function () { L.bm = L.bm.filter(function (y) { return y.id !== x.id; }); saveL("bm"); drawPane(); });
            acts.appendChild(db);
          }
          li.appendChild(acts);
          ol.appendChild(li);
        });
        pane.appendChild(ol);
      }
      addLive(drawPane);
    }
  });

  if (SOCIAL) R.view("reader", {
    title: "读者主页",
    render: function (box, id) {
      addLive(function () {
        box.innerHTML = "";
        if (!S.loaded) { box.appendChild(el("p", { class: "empty", text: sharedState() === "ok" || sharedState() === "readonly" ? "加载中……" : sharedNote() })); return; }
        var u = S.users[id];
        if (!u) { box.appendChild(el("p", { class: "empty", text: "没有找到这位读者。" })); return; }
        names([id]).then(function (map) {
          var p = map[id] || {};
          var head = el("header", { class: "vw-h me-h" });
          if (p.avatarUrl) head.appendChild(el("img", { class: "av", src: p.avatarUrl, alt: "", width: 64, height: 64 }));
          var t = el("div");
          t.appendChild(el("p", { class: "kicker", text: D.title + " · 读者" }));
          t.appendChild(el("h1", { text: p.name || "一位读者" }));
          var d = new Date(u.joined || Date.now());
          t.appendChild(el("p", { class: "lede", text: "从 " + d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日起在这里留言。" }));
          head.appendChild(t);
          box.appendChild(head);
          var tiles = [["评论", (u.comments || []).length + " 条"], ["公开划线", (u.hl || []).length + " 条"]];
          if (u.stats) { tiles.unshift(["阅读时长", dur(u.stats.sec)]); tiles.unshift(["读完", (u.stats.done || []).length + " / " + N + " 章"]); }
          box.appendChild(statTiles(tiles));
          if (u.review && u.review.text) {
            box.appendChild(el("h2", { text: "读后感" }));
            var art = el("article", { class: "rv" });
            u.review.text.split(/\n+/).forEach(function (x) { art.appendChild(el("p", { text: x })); });
            box.appendChild(art);
          }
          if ((u.hl || []).length) {
            box.appendChild(el("h2", { text: "公开划线" }));
            var ol = el("ol", { class: "find-list" });
            u.hl.slice().sort(function (a, b) { return a.ch - b.ch || a.p - b.p; }).forEach(function (h) {
              var li = el("li"); li.appendChild(el("a", { href: R.chHref(h.ch, h.p) }, "<small>" + esc(chName(h.ch)) + "</small><span>" + esc(h.t) + "</span>")); ol.appendChild(li);
            });
            box.appendChild(ol);
          }
          if ((u.comments || []).length) {
            box.appendChild(el("h2", { text: "评论" }));
            var likes = likeCounts();
            var ul = el("ul", { class: "cm-list" });
            u.comments.slice().sort(function (a, b) { return b.ts - a.ts; }).slice(0, 50).forEach(function (c) { var x = clone(c); x.uid = id; ul.appendChild(commentItem(x, map, likes, { showWhere: true })); });
            box.appendChild(ul);
          }
        });
      });
    }
  });

  /* =====================================================================
   * 作者后台
   * ===================================================================== */
  if (SOCIAL) R.view("admin", {
    title: "作者后台",
    render: function (box, arg) {
      box.innerHTML = '<header class="vw-h"><p class="kicker">' + esc(D.title) + '</p><h1>作者后台</h1><p class="lede">只有作者能看到这一页。阅读统计只包括登录过的读者。</p></header>';
      var body = el("div");
      box.appendChild(body);
      var statsDocs = null, loading = false;
      addLive(function () {
        if (!C.ready) { body.innerHTML = '<p class="empty">正在连接……</p>'; return; }
        if (!C.owner) { body.innerHTML = '<p class="empty">这一页只有作者能看。</p>'; return; }
        if (!C.db) { body.innerHTML = '<p class="empty">' + esc(sharedNote()) + "</p>"; return; }
        if (!statsDocs && !loading) {
          loading = true;
          C.db.collection("s").get().then(function (snap) { statsDocs = {}; snap.docs.forEach(function (d) { if (d.exists) statsDocs[d.id] = d.data(); }); draw(); }, function () { statsDocs = {}; draw(); });
        }
        draw();
      });
      function draw() {
        body.innerHTML = "";
        var st = statsDocs || {};
        var rids = Object.keys(st);
        var tot = 0, finished = 0, per = {};
        rids.forEach(function (r) {
          var ch = st[r].ch || {}, all = true;
          for (var i = 1; i <= N; i++) {
            var x = ch[i];
            if (!x || !x.done) all = false;
            if (!x) continue;
            per[i] = per[i] || { readers: 0, sec: 0, done: 0, v: 0 };
            per[i].readers++; per[i].sec += x.sec || 0; per[i].done += x.done ? 1 : 0; per[i].v += x.v || 0;
            tot += x.sec || 0;
          }
          if (all) finished++;
        });
        var cms = allComments();
        var active7 = rids.filter(function (r) { return (st[r].last || 0) > Date.now() - 7 * 86400000; }).length;
        body.appendChild(el("h2", { text: "读者概况" }));
        body.appendChild(statTiles([
          ["读者（UV）", rids.length + " 人"],
          ["打开章节（PV）", String(Object.keys(per).reduce(function (s, k) { return s + per[k].v; }, 0)) + " 次"],
          ["近 7 天活跃", active7 + " 人"],
          ["读完全书", finished + " 人"],
          ["总阅读时长", dur(tot)],
          ["人均", rids.length ? dur(tot / rids.length) : "—"],
          ["评论", cms.length + " 条"],
          ["读后感", Object.keys(S.users).filter(function (u) { return S.users[u].review; }).length + " 篇"]
        ]));
        if (statsDocs === null) body.appendChild(el("p", { class: "tip", text: "统计加载中……" }));

        body.appendChild(el("h2", { text: "每一章" }));
        var maxR = 1; Object.keys(per).forEach(function (k) { maxR = Math.max(maxR, per[k].readers); });
        var tw = el("div", { class: "tbl" });
        var tb = el("table");
        tb.innerHTML = "<thead><tr><th>章</th><th>读者</th><th>读完</th><th>人均时长</th><th>打开次数</th></tr></thead>";
        var tbody = el("tbody");
        CH.forEach(function (c) {
          var x = per[c.n] || { readers: 0, sec: 0, done: 0, v: 0 };
          var tr = el("tr");
          tr.innerHTML = '<td><a href="' + R.chHref(c.n) + '">' + esc(chName(c.n)) + "</a></td>" +
            '<td><span class="bar-c"><i style="width:' + Math.round(x.readers / maxR * 100) + '%"></i></span>' + x.readers + "</td>" +
            "<td>" + x.done + (x.readers ? "（" + Math.round(x.done / x.readers * 100) + "%）" : "") + "</td>" +
            "<td>" + (x.readers ? dur(x.sec / x.readers) : "—") + "</td><td>" + x.v + "</td>";
          tbody.appendChild(tr);
        });
        tb.appendChild(tbody); tw.appendChild(tb); body.appendChild(tw);

        // 热门划线
        body.appendChild(el("h2", { text: "热门划线" }));
        var hot = {};
        Object.keys(S.users).forEach(function (u) {
          (S.users[u].hl || []).forEach(function (h) {
            var k = h.ch + ":" + h.p + ":" + h.t;
            hot[k] = hot[k] || { ch: h.ch, p: h.p, t: h.t, n: 0 };
            hot[k].n++;
          });
        });
        var hotList = Object.keys(hot).map(function (k) { return hot[k]; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 12);
        if (!hotList.length) body.appendChild(el("p", { class: "empty", text: "还没有读者公开划线。" }));
        else {
          var ol = el("ol", { class: "find-list" });
          hotList.forEach(function (h) { var li = el("li"); li.appendChild(el("a", { href: R.chHref(h.ch, h.p) }, "<small>" + esc(chName(h.ch)) + " · " + h.n + " 人划过</small><span>" + esc(h.t) + "</span>")); ol.appendChild(li); });
          body.appendChild(ol);
        }

        // 评论管理
        body.appendChild(el("h2", { text: "全部评论" }));
        var sorted = cms.slice().sort(function (a, b) { return b.ts - a.ts; });
        names(sorted.map(function (c) { return c.uid; })).then(function (map) {
          var likes = likeCounts();
          var ul = el("ul", { class: "cm-list" });
          sorted.slice(0, 200).forEach(function (c) { ul.appendChild(commentItem(c, map, likes, { showWhere: true })); });
          if (recapsSec.parentNode !== body) return;
          if (!sorted.length) body.insertBefore(el("p", { class: "empty", text: "还没有评论。" }), recapsSec);
          else body.insertBefore(ul, recapsSec);
        });

        // 前情提要
        var recapsSec = el("section", { id: "recaps", class: "recap-ed" });
        recapsSec.appendChild(el("h2", { text: "前情提要" }));
        recapsSec.appendChild(el("p", { class: "tip", text: "改了的会覆盖书里自带的那一版；清空就恢复原样。" }));
        var form = el("form");
        CH.forEach(function (c) {
          if (c.n === 1) return;
          var lab = el("label", { class: "rc" });
          lab.appendChild(el("span", { text: chName(c.n) + " 开头（讲" + chShort(c.n - 1) + "）" }));
          var ta = el("textarea", { id: "rc" + c.n, rows: 3, "data-n": c.n });
          ta.value = (S.recaps && S.recaps[String(c.n)]) || c.recap || "";
          lab.appendChild(ta);
          form.appendChild(lab);
        });
        var sv = el("button", { type: "submit", class: "btn-s pri", text: "保存前情提要" });
        form.appendChild(sv);
        form.addEventListener("submit", function (e) {
          e.preventDefault();
          var out = {};
          form.querySelectorAll("textarea").forEach(function (t) {
            var n = t.getAttribute("data-n"), v = t.value.trim(), def = CH[n - 1].recap || "";
            if (v && v !== def) out[n] = v;
          });
          sv.disabled = true;
          C.db.doc("edit/recaps").set(out).then(function () { R.toast("前情提要已保存"); }, writeErr).then(function () { sv.disabled = false; });
        });
        recapsSec.appendChild(form);
        body.appendChild(recapsSec);
        if (arg === "recaps") setTimeout(function () { recapsSec.scrollIntoView(); }, 50);
      }
    }
  });

  /* =====================================================================
   * 书封页的入口
   * ===================================================================== */
  R.on("home", function (view) {
    var q = view.querySelector('[data-slot="home-links"]');
    if (!q) return;
    var links = [];
    if (PEOPLE.length) links.push(["#people", "人物"]);
    if (TL.length) links.push(["#timeline", "时间线"]);
    if (SOCIAL) links.push(["#reviews", "读后感"]);
    links.push(["#shelf", "我的书房"]);
    q.innerHTML = "";
    links.forEach(function (x) { q.appendChild(el("a", { class: "qk", href: x[0], text: x[1] })); });
    var s = el("button", { type: "button", class: "qk", text: "搜索" });
    s.addEventListener("click", function () { openSearch(); });
    q.appendChild(s);
    addLive(function () {
      var ad = q.querySelector(".qk-admin");
      if (C.owner && !ad) q.appendChild(el("a", { class: "qk qk-admin", href: "#admin", text: "作者后台" }));
    });
  });

  initCaps();
  R.start();
})();
