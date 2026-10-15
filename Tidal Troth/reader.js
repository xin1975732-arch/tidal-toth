/* 账本三部曲 · 阅读器内核 reader.js —— kit v2.0
 *
 * 单页阅读器：书封、目录、每一章都在同一个页面里，用锚点切换：
 *   #            书封和目录
 *   #mulu        目录
 *   #ch05        第五章
 *   #ch05-p12    第五章第 12 段（滚到那里，闪一下）
 *   #people …    其他页面由 features.js 用 Reader.view() 登记
 *
 * 页面在加载本文件之前要有：
 *   <script type="application/json" id="book-data">  构建脚本写进去的全书数据
 *   window.BOOK = { key, tones, light, dark, head, sound }
 * 想要自己的章首动画或环境声：先加载 scene.js，往
 *   window.READER_SCENES = { heads: { 名字: paint }, sounds: { 名字: start } } 里登记
 *   paint(ctx, w, h, t, cols)  每帧画一次；t 是秒，cols 是 --scene-1..4
 *   start(ac, out, api)        api.noise(秒) / api.later(fn, 毫秒) / api.on()；返回关掉时要 stop() 的节点
 *
 * 给 features.js 的接口：window.Reader（见文件末尾）。
 */
(function () {
  "use strict";

  var B = window.BOOK || {};
  var K = B.key || "rd";
  var D = {};
  try { D = JSON.parse(document.getElementById("book-data").textContent); } catch (e) { D = { chapters: [] }; }
  var CH = D.chapters || [];
  var N = CH.length;
  var TONES = B.tones || ["light", "dark"];
  var LIGHT = B.light || TONES[0];
  var DARK = B.dark || TONES[TONES.length - 1];
  var root = document.documentElement;
  var app = document.getElementById("app");
  var view = document.getElementById("view");
  var bar = document.querySelector(".bar");
  var barHome = document.getElementById("barHome");
  var barMid = document.querySelector(".bar-mid");
  var prog = document.querySelector(".bar-prog i");
  var gauge = document.querySelector(".gauge");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 小工具 ---------- */
  function get(k) { try { return window.localStorage.getItem(K + "." + k); } catch (e) { return null; } }
  function set(k, v) { try { window.localStorage.setItem(K + "." + k, v); } catch (e) {} }
  function getJSON(k, d) { try { var v = get(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function setJSON(k, v) { set(k, JSON.stringify(v)); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (a) {
      if (a === "class") e.className = attrs[a];
      else if (a === "text") e.textContent = attrs[a];
      else if (a.slice(0, 2) === "on") e.addEventListener(a.slice(2), attrs[a]);
      else if (attrs[a] != null && attrs[a] !== false) e.setAttribute(a, attrs[a] === true ? "" : attrs[a]);
    });
    if (html != null) e.innerHTML = html;
    return e;
  }
  var handlers = {};
  function on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); }
  function emit(evt) {
    var a = Array.prototype.slice.call(arguments, 1);
    (handlers[evt] || []).forEach(function (fn) { try { fn.apply(null, a); } catch (e) { if (window.console) console.error(e); } });
  }
  function chHref(n, p) { return "#ch" + pad(n) + (p != null ? "-p" + p : ""); }

  var toastT = 0, toastEl = null;
  function toast(msg) {
    if (!toastEl) { toastEl = el("div", { class: "toast", role: "status", "aria-live": "polite" }); document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add("on");
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove("on"); }, 2200);
  }

  /* 底部抽屉 / 侧边面板：同一时间只开一个 */
  var curSheet = null;
  function sheet(opts) {
    if (curSheet) curSheet.close();
    var back = el("div", { class: "sheet-back" });
    var box = el("section", { class: "sheet" + (opts.cls ? " " + opts.cls : ""), role: "dialog", "aria-modal": "true", "aria-label": opts.title || "" });
    var head = el("header", { class: "sheet-h" });
    head.appendChild(el("h2", { text: opts.title || "" }));
    var x = el("button", { class: "sheet-x", type: "button", "aria-label": "关闭" }, "×");
    head.appendChild(x);
    var body = el("div", { class: "sheet-b" });
    if (typeof opts.body === "string") body.innerHTML = opts.body; else if (opts.body) body.appendChild(opts.body);
    box.appendChild(head); box.appendChild(body);
    var prevFocus = document.activeElement;
    function close() {
      if (!back.parentNode) return;
      back.parentNode.removeChild(back); box.parentNode.removeChild(box);
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("sheet-open");
      if (curSheet === api) curSheet = null;
      if (opts.onClose) opts.onClose();
      if (prevFocus && prevFocus.focus) try { prevFocus.focus({ preventScroll: true }); } catch (e) {}
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    back.addEventListener("click", close);
    x.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(back); document.body.appendChild(box);
    document.body.classList.add("sheet-open");
    setTimeout(function () { x.focus({ preventScroll: true }); }, 30);
    var api = { el: box, body: body, close: close };
    curSheet = api;
    return api;
  }

  /* ---------- 内置场景：潮水 + 海浪声（来自《潮信》） ---------- */
  var SC = window.READER_SCENES || {};
  var HEADS = SC.heads || {};
  var SOUNDS = SC.sounds || {};

  if (!HEADS.tide) HEADS.tide = function (ctx, w, h, t, cols) {
    var layers = [
      { c: 0, a: .55, amp: .10, k: 1.6, sp: .22, y: .30 },
      { c: 1, a: .55, amp: .12, k: 2.2, sp: -.30, y: .48 },
      { c: 2, a: .50, amp: .10, k: 2.9, sp: .38, y: .64 },
      { c: 3, a: .85, amp: .08, k: 3.6, sp: -.46, y: .80 }
    ];
    var swell = Math.sin(t * 0.25) * 0.04;
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i], base = h * (L.y - swell);
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (var x = 0; x <= w + 8; x += 8) {
        ctx.lineTo(x, base + Math.sin((x / w) * Math.PI * 2 * L.k + t * L.sp * 2) * h * L.amp * 0.5
                          + Math.sin((x / w) * Math.PI * 2 * (L.k * 0.5) - t * L.sp) * h * L.amp * 0.35);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.globalAlpha = L.a;
      ctx.fillStyle = cols[L.c];
      ctx.fill();
    }
    ctx.globalAlpha = .9;
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    var b2 = h * (layers[3].y - swell) + h * 0.07;
    for (var row = 0; row < 2; row++) {
      ctx.beginPath();
      var yy = b2 + row * h * 0.07;
      for (var x2 = -20; x2 <= w + 20; x2 += 34) {
        var off = (t * 14 * (row ? -1 : 1)) % 34;
        ctx.moveTo(x2 + off, yy);
        ctx.quadraticCurveTo(x2 + off + 8.5, yy - 6, x2 + off + 17, yy);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  if (!SOUNDS.sea) SOUNDS.sea = function (ac, out, api) {
    function layer(secs, freq, gain, lfoHz, lfoDepth, sweep) {
      var s = ac.createBufferSource(); s.buffer = api.noise(secs); s.loop = true;
      var lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = freq;
      var g = ac.createGain(); g.gain.value = gain;
      s.connect(lp); lp.connect(g); g.connect(out);
      var lfo = ac.createOscillator(); lfo.frequency.value = lfoHz;
      var lg = ac.createGain(); lg.gain.value = lfoDepth; lfo.connect(lg); lg.connect(g.gain);
      var nodes = [s, lfo];
      if (sweep) {
        var lf = ac.createOscillator(); lf.frequency.value = lfoHz;
        var lgf = ac.createGain(); lgf.gain.value = sweep; lf.connect(lgf); lgf.connect(lp.frequency);
        lf.start(); nodes.push(lf);
      }
      s.start(); lfo.start();
      return nodes;
    }
    function horn() {
      if (!api.on()) return;
      var t = ac.currentTime + 0.05, g = ac.createGain(), lp = ac.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 520;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.6);
      g.gain.setValueAtTime(0.09, t + 2.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
      [98, 147].forEach(function (f) {
        var o = ac.createOscillator(); o.type = "sawtooth"; o.frequency.value = f;
        o.connect(lp); o.start(t); o.stop(t + 4.4);
      });
      lp.connect(g); g.connect(out);
      api.later(horn, 45000 + Math.random() * 50000);
    }
    api.later(horn, 12000 + Math.random() * 8000);
    return layer(5, 900, 0.35, 0.11, 0.3, 500).concat(layer(7, 320, 0.5, 0.07, 0.25, 0));
  };

  /* ---------- 设置 ---------- */
  var SIZES = [16, 17, 18, 19, 20, 22, 24];
  function defaultSize() { return window.matchMedia("(max-width: 600px)").matches ? 18 : 19; }
  var fs = parseInt(get("fs") || "0", 10) || defaultSize();
  var read = get("tone");
  if (TONES.indexOf(read) < 0) read = null;
  var waveOn = get("wave") !== "off";
  var darkMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function effectiveRead() {
    if (read) return read;
    var t = root.getAttribute("data-theme");
    if (t === "dark") return DARK;
    if (t === "light") return LIGHT;
    return darkMq && darkMq.matches ? DARK : LIGHT;
  }
  function applyRead() {
    if (read) root.setAttribute("data-read", read); else root.removeAttribute("data-read");
    var eff = effectiveRead();
    document.querySelectorAll(".sw").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-read") === eff ? "true" : "false");
    });
    Head.recolor();
    emit("tone", eff);
  }
  if (darkMq && darkMq.addEventListener) darkMq.addEventListener("change", function () { if (!read) applyRead(); });

  function applySize() {
    root.style.setProperty("--fs", fs + "px");
    var out = document.querySelector(".stepper output");
    if (out) out.textContent = fs + " 号";
    var dn = document.querySelector('[data-step="-1"]'), up = document.querySelector('[data-step="1"]');
    if (dn) dn.disabled = fs <= SIZES[0];
    if (up) up.disabled = fs >= SIZES[SIZES.length - 1];
  }
  function applyWave() {
    if (waveOn) root.removeAttribute("data-wave"); else root.setAttribute("data-wave", "off");
    var sw = document.getElementById("waveSw");
    if (sw) sw.setAttribute("aria-checked", waveOn ? "true" : "false");
    Head.toggle(waveOn);
  }

  var aa = document.getElementById("aa");
  var panel = document.getElementById("panel");
  function openPanel(open) {
    if (!panel || !aa) return;
    panel.hidden = !open;
    aa.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (aa && panel) {
    aa.addEventListener("click", function (e) { e.stopPropagation(); openPanel(panel.hidden); });
    panel.addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("click", function () { if (!panel.hidden) openPanel(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !panel.hidden) { openPanel(false); aa.focus(); } });
    panel.querySelectorAll(".sw").forEach(function (b) {
      b.addEventListener("click", function () { read = b.getAttribute("data-read"); set("tone", read); applyRead(); });
    });
    panel.querySelectorAll("[data-step]").forEach(function (b) {
      b.addEventListener("click", function () {
        var i = SIZES.indexOf(fs); if (i < 0) i = 3;
        i = Math.max(0, Math.min(SIZES.length - 1, i + parseInt(b.getAttribute("data-step"), 10)));
        var ratio = progress();
        fs = SIZES[i]; set("fs", String(fs)); applySize();
        if (cur.ch) restore(ratio);
      });
    });
    var ws = document.getElementById("waveSw");
    if (ws) ws.addEventListener("click", function () { waveOn = !waveOn; set("wave", waveOn ? "on" : "off"); applyWave(); });
  }

  /* ---------- 章首动画：每次换页重新挂到新的画布上 ---------- */
  var Head = (function () {
    var list = [];
    var paintFn = HEADS[B.head || "tide"] || null;
    var cols = ["#F2B53A", "#D9622B", "#C23B6B", "#3F7BD9"];
    function readColors() {
      var cs = getComputedStyle(root);
      var fall = ["--hi", "--acc", "--acc2", "--alt"];
      cols = [1, 2, 3, 4].map(function (n, i) {
        return (cs.getPropertyValue("--scene-" + n) || "").trim() || (cs.getPropertyValue(fall[i]) || "").trim() || cols[i];
      });
    }
    function make(cv) {
      var ctx = cv.getContext("2d");
      var w = 0, h = 0, raf = 0, seen = true, t0 = 0, io = null;
      function size() {
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        var r = cv.getBoundingClientRect();
        w = Math.max(1, r.width); h = Math.max(1, r.height);
        cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paint(0);
      }
      function paint(t) { ctx.clearRect(0, 0, w, h); paintFn(ctx, w, h, t, cols); }
      function loop(ts) { if (!t0) t0 = ts; paint((ts - t0) / 1000); raf = window.requestAnimationFrame(loop); }
      function start() { if (raf || reduce || !waveOn || !seen || document.hidden) return; raf = window.requestAnimationFrame(loop); }
      function stop() { if (raf) window.cancelAnimationFrame(raf); raf = 0; }
      if ("IntersectionObserver" in window) {
        io = new IntersectionObserver(function (es) { seen = es[0].isIntersecting; if (seen) start(); else stop(); });
        io.observe(cv);
      }
      size();
      return { start: start, stop: stop, size: size, repaint: function () { paint(0); }, kill: function () { stop(); if (io) io.disconnect(); } };
    }
    var tm;
    window.addEventListener("resize", function () { clearTimeout(tm); tm = setTimeout(function () { list.forEach(function (r) { r.size(); }); }, 150); });
    document.addEventListener("visibilitychange", function () { list.forEach(function (r) { if (document.hidden) r.stop(); else r.start(); }); });
    function mount(scope) {
      list.forEach(function (r) { r.kill(); });
      list = [];
      var cvs = scope.querySelectorAll("canvas.scene");
      if (!paintFn) { cvs.forEach(function (cv) { cv.hidden = true; }); return; }
      readColors();
      cvs.forEach(function (cv) { list.push(make(cv)); });
      list.forEach(function (r) { r.start(); });
    }
    return {
      mount: mount,
      toggle: function (on) { list.forEach(function (r) { if (on) r.start(); else r.stop(); }); },
      recolor: function () { readColors(); list.forEach(function (r) { r.repaint(); }); }
    };
  })();

  /* ---------- 环境声 ---------- */
  var Sound = (function () {
    var startFn = SOUNDS[B.sound] || null;
    var ac = null, master = null, nodes = [], timers = [], on = false;
    function noise(secs) {
      var len = Math.floor(ac.sampleRate * secs), b = ac.createBuffer(1, len, ac.sampleRate), d = b.getChannelData(0);
      var b0 = 0, b1 = 0, b2 = 0;
      for (var i = 0; i < len; i++) {
        var wv = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + wv * 0.0990460; b1 = 0.96300 * b1 + wv * 0.2965164; b2 = 0.57000 * b2 + wv * 1.0526913;
        d[i] = (b0 + b1 + b2 + wv * 0.1848) * 0.16;
      }
      return b;
    }
    var api = {
      noise: function (s) { return noise(s); },
      later: function (fn, ms) { timers.push(setTimeout(fn, ms)); },
      on: function () { return on; }
    };
    function start() {
      if (on) return true;
      if (!startFn) return false;
      try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return false; }
      if (ac.resume) ac.resume();
      master = ac.createGain(); master.gain.value = 0.0001; master.connect(ac.destination);
      on = true;
      nodes = startFn(ac, master, api) || [];
      var t = ac.currentTime;
      master.gain.setValueAtTime(0.0001, t);
      master.gain.exponentialRampToValueAtTime(0.7, t + 2.5);
      return true;
    }
    function stop() {
      if (!on) return;
      on = false;
      timers.forEach(clearTimeout); timers = [];
      var t = ac.currentTime, m = master, ns = nodes;
      m.gain.cancelScheduledValues(t); m.gain.setValueAtTime(m.gain.value || 0.0001, t); m.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      setTimeout(function () { ns.forEach(function (s) { try { s.stop(); } catch (e) {} }); try { m.disconnect(); } catch (e) {} }, 1400);
    }
    document.addEventListener("visibilitychange", function () {
      if (!ac || !on) return;
      if (document.hidden) ac.suspend(); else ac.resume();
    });
    return { start: start, stop: stop, isOn: function () { return on; } };
  })();

  var snd = document.getElementById("snd");
  if (snd) {
    snd.addEventListener("click", function (e) {
      e.stopPropagation();
      if (Sound.isOn()) { Sound.stop(); set("sound", "off"); }
      else if (Sound.start()) { set("sound", "on"); }
      snd.setAttribute("aria-pressed", Sound.isOn() ? "true" : "false");
    });
  }

  /* ---------- 进度 ---------- */
  function progress() {
    var a = view.querySelector("article.text");
    if (!a) return 0;
    var top = a.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.3;
    var span = a.offsetHeight - window.innerHeight * 0.4;
    if (span <= 0) return 1;
    return Math.min(1, Math.max(0, (window.scrollY - top) / span));
  }
  function restore(ratio) {
    var a = view.querySelector("article.text");
    if (!a) return;
    var top = a.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.3;
    var span = a.offsetHeight - window.innerHeight * 0.4;
    window.scrollTo(0, Math.max(0, Math.round(top + ratio * span)));
  }
  function maxRead() {
    var m = parseInt(get("last") || "0", 10) || 0;
    (get("done") || "").split(",").forEach(function (x) { var n = parseInt(x, 10); if (n > m) m = n; });
    if (cur.ch > m) m = cur.ch;
    return m;
  }
  var saveT = 0;
  function onScroll() {
    if (!cur.ch) return;
    var p = progress();
    if (prog) prog.style.transform = "scaleX(" + p.toFixed(4) + ")";
    if (gauge) gauge.style.setProperty("--p", p.toFixed(4));
    var n = cur.ch;
    clearTimeout(saveT);
    saveT = setTimeout(function () {
      set("pos." + n, p.toFixed(4));
      if (p > 0.96) {
        var done = (get("done") || "").split(",").filter(Boolean);
        if (done.indexOf(String(n)) < 0) { done.push(String(n)); set("done", done.join(",")); emit("done", n); }
      }
    }, 300);
  }
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- 页面 ---------- */
  var VIEWS = {};
  var cur = { name: "", arg: "", ch: 0 };
  var flags = { resume: false };
  var titleIO = null;

  function seriesNav() {
    var s = D.series_nav || [];
    if (!s.length) return "";
    return '<nav class="series-nav" aria-label="' + esc(D.series || "系列") + '"><span class="sn-l">' + esc(D.series) + '</span>' +
      s.map(function (b) {
        if (b.state === "current") return '<b class="sn-b cur" aria-current="page">' + esc(b.title) + "</b>";
        if (!b.url) return '<span class="sn-b soon">' + esc(b.title) + "<small>即将上线</small></span>";
        return '<a class="sn-b" href="' + esc(b.url) + '" target="_blank" rel="noopener">' + esc(b.title) + "</a>";
      }).join("") + "</nav>";
  }
  function footer() { return seriesNav() + '<footer class="foot">' + esc(D.foot) + "</footer>"; }

  function renderHome(el) {
    var toc = CH.map(function (c) {
      return '<li><a href="' + chHref(c.n) + '" data-n="' + c.n + '"' + (c.era ? ' class="era"' : "") + ' aria-label="第' + c.cn + "章 " + esc(c.title) + '">' +
        '<span class="toc-no">' + pad(c.n) + '</span><span class="toc-t">' + esc(c.title) + '</span><span><span class="toc-tag" hidden>读到这里</span></span><span class="toc-m">' + c.mins + " 分钟</span></a></li>";
    }).join("\n");
    var legend = "";
    if (D.legend_now) legend += '<i class="k-now"></i>' + esc(D.legend_now) + "，";
    if (D.era_legend && CH.some(function (c) { return c.era; })) legend += '<i class="k-era"></i>' + esc(D.era_legend) + "。";
    legend = legend.replace(/，$/, "");
    var total = D.total >= 10000 ? (D.total / 10000).toFixed(1) + "万" : String(D.total);
    var epi = D.epigraph ? '<figure class="epi"><blockquote>' + D.epigraph.html + "</blockquote><figcaption>" + esc(D.epigraph.cite || "") + "</figcaption></figure>" : "";
    var series = D.series ? '<p class="series">' + esc(D.series + (D.series_no ? " · " + D.series_no : "")) + "</p>" : "";
    el.innerHTML =
      '<section class="hero"><div class="hero-in">' + (D.cover ? '<div class="cover">' + D.cover + "</div>" : "") +
      '<div class="hero-text">' + series + '<h1 class="wordmark">' + esc(D.title) + "</h1>" + epi +
      '<p class="blurb">' + esc(D.blurb) + "</p>" +
      '<div class="cta"><a class="btn btn-primary" id="go" href="#ch01">开始阅读</a><a class="btn btn-ghost" id="again" href="#ch01" hidden>从头读起</a><a class="btn btn-ghost" href="#mulu">目录</a></div>' +
      '<div class="quick" data-slot="home-links"></div>' +
      "</div></div></section>" +
      '<section class="mulu" id="mulu" aria-labelledby="mulu-h"><h2 id="mulu-h">目录</h2><ol class="toc" style="--rows:' + Math.ceil(N / 2) + '">' + toc + "</ol>" +
      '<p class="mulu-note">全书' + toCn(N) + "章，约" + total + "字。" + legend + (D.toc_note_extra ? "<br>" + esc(D.toc_note_extra) : "") + "</p></section>" +
      footer();
    var last = parseInt(get("last") || "0", 10);
    var go = el.querySelector("#go"), again = el.querySelector("#again");
    if (last >= 1 && last <= N) {
      var pos = parseFloat(get("pos." + last) || "0");
      var nextUp = last;
      if (pos > 0.96 && last < N) nextUp = last + 1;
      var c = CH[nextUp - 1];
      go.href = chHref(nextUp);
      go.textContent = "接着读 · 第" + c.cn + "章　" + c.title;
      if (nextUp === last) go.addEventListener("click", function () { flags.resume = true; });
      again.hidden = false;
    }
    var done = (get("done") || "").split(",");
    el.querySelectorAll(".toc a").forEach(function (a) {
      var n = a.getAttribute("data-n");
      if (done.indexOf(n) >= 0) a.classList.add("done");
      if (String(last) === n) { var tag = a.querySelector(".toc-tag"); if (tag) tag.hidden = false; }
      if (String(last) === n) a.addEventListener("click", function () { flags.resume = true; });
    });
  }
  function toCn(n) { var c = CH[n - 1]; return c ? c.cn : String(n); }

  function renderChapter(el, n) {
    var c = CH[n - 1];
    var prev = n > 1 ? CH[n - 2] : null, next = n < N ? CH[n] : null;
    el.innerHTML =
      '<header class="ch-head' + (c.era ? " era" : "") + '"><canvas class="scene" aria-hidden="true"></canvas>' +
      '<div class="ch-head-in"><div class="tag" aria-hidden="true"><small>第</small><b>' + pad(n) + '</b><small>章</small></div>' +
      '<p class="ch-no">第' + c.cn + "章" + (c.era ? "　·　" + esc(c.era) : "") + '</p><h1 class="ch-title">' + esc(c.title) + "</h1></div>" +
      '<p class="ch-meta"><span>' + c.chars.toLocaleString("en-US") + " 字 · 约 " + c.mins + " 分钟</span></p></header>" +
      '<div class="ch-pre" data-slot="pre"></div>' +
      '<article class="text" lang="zh-CN" data-ch="' + n + '">' + c.html + "</article>" +
      '<div class="ch-end">' + (D.end || "") + (n === N ? '<p class="fin">全书完</p>' : "<p>第" + c.cn + "章　完</p>") + "</div>" +
      '<div class="ch-post" data-slot="post"></div>' +
      '<nav class="ch-nav" aria-label="翻章">' +
      '<a class="pv" href="' + (prev ? chHref(n - 1) : "#") + '"><small>' + (prev ? "上一章" : "书封") + "</small><b>" + (prev ? "第" + prev.cn + "章　" + esc(prev.title) : esc(D.title)) + "</b></a>" +
      '<a class="nx" href="' + (next ? chHref(n + 1) : "#mulu") + '" rel="next"><small>' + (next ? "下一章" : "回到") + "</small><b>" + (next ? "第" + next.cn + "章　" + esc(next.title) : "目录") + "</b></a></nav>" +
      footer();
  }

  function parseHash() {
    var h = (location.hash || "").replace(/^#/, "");
    var m = /^ch(\d{1,3})(?:-p(\d+))?$/.exec(h);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n >= 1 && n <= N) return { name: "chapter", ch: n, p: m[2] != null ? parseInt(m[2], 10) : null };
    }
    if (h === "" || h === "home") return { name: "home" };
    if (h === "mulu") return { name: "home", anchor: "mulu" };
    var v = /^([a-z]+)(?:-(.+))?$/.exec(h);
    if (v && VIEWS[v[1]]) return { name: v[1], arg: v[2] || "" };
    return { name: "home" };
  }

  function flash(node) {
    node.classList.remove("flash"); void node.offsetWidth; node.classList.add("flash");
    setTimeout(function () { node.classList.remove("flash"); }, 2200);
  }
  function scrollToPara(p) {
    var node = view.querySelector('article.text [data-p="' + p + '"]');
    if (!node) return false;
    var y = node.getBoundingClientRect().top + window.scrollY - (bar ? bar.offsetHeight : 0) - window.innerHeight * 0.18;
    window.scrollTo(0, Math.max(0, y));
    flash(node);
    return true;
  }

  function route() {
    var r = parseHash();
    if (r.name === "chapter" && cur.name === "chapter" && cur.ch === r.ch) {
      if (r.p != null) scrollToPara(r.p);
      return;
    }
    if (curSheet) curSheet.close();
    openPanel(false);
    var prevCh = cur.ch;
    cur = { name: r.name, arg: r.arg || "", ch: r.name === "chapter" ? r.ch : 0 };
    app.setAttribute("data-ch", String(cur.ch));
    app.setAttribute("data-view", r.name);
    if (titleIO) { titleIO.disconnect(); titleIO = null; }
    bar.classList.remove("show-title");
    view.innerHTML = "";
    if (gauge) gauge.hidden = r.name !== "chapter";
    if (prog) prog.style.transform = "scaleX(0)";
    emit("leave", prevCh);

    if (r.name === "home") {
      barHome.href = "#";
      barHome.innerHTML = '<span class="bar-mark">' + esc(D.title) + "</span>";
      barMid.textContent = "";
      renderHome(view);
      document.title = D.title;
      Head.mount(view);
      emit("home", view);
      if (r.anchor) { var a = document.getElementById(r.anchor); if (a) a.scrollIntoView(); } else window.scrollTo(0, 0);
      return;
    }
    barHome.href = r.name === "chapter" ? "#mulu" : "#";
    barHome.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>' + (r.name === "chapter" ? "目录" : "书封");

    if (r.name === "chapter") {
      var c = CH[r.ch - 1];
      barMid.textContent = "第" + c.cn + "章 · " + c.title;
      document.title = "第" + c.cn + "章　" + c.title + " · " + D.title;
      renderChapter(view, r.ch);
      set("last", String(r.ch));
      Head.mount(view);
      var t = view.querySelector(".ch-title");
      if (t && "IntersectionObserver" in window) {
        titleIO = new IntersectionObserver(function (es) { bar.classList.toggle("show-title", !es[0].isIntersecting); },
          { rootMargin: "-" + (bar.offsetHeight + 10) + "px 0px 0px 0px" });
        titleIO.observe(t);
      }
      emit("chapter", r.ch, view, r.p);
      var doResume = flags.resume; flags.resume = false;
      var after = function () {
        if (r.p != null) { if (!scrollToPara(r.p)) window.scrollTo(0, 0); }
        else if (doResume) { var s = parseFloat(get("pos." + r.ch) || "0"); if (s > 0.01) restore(s); else window.scrollTo(0, 0); }
        else window.scrollTo(0, 0);
        onScroll();
      };
      window.scrollTo(0, 0);
      if ((r.p != null || doResume) && document.fonts && document.fonts.ready) document.fonts.ready.then(function () { setTimeout(after, 30); });
      else after();
      return;
    }
    var spec = VIEWS[r.name];
    barMid.textContent = spec.title || "";
    document.title = (spec.title ? spec.title + " · " : "") + D.title;
    var box = document.createElement("div");
    box.className = "vw vw-" + r.name;
    view.appendChild(box);
    try { spec.render(box, r.arg || ""); } catch (e) { if (window.console) console.error(e); }
    view.insertAdjacentHTML("beforeend", footer());
    window.scrollTo(0, 0);
    emit("view", r.name, r.arg, box);
  }
  window.addEventListener("hashchange", route);

  document.addEventListener("keydown", function (e) {
    if (!cur.ch || curSheet) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var tag = (e.target && e.target.tagName) || "";
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
    if (e.key === "ArrowLeft" && cur.ch > 1) location.hash = chHref(cur.ch - 1);
    if (e.key === "ArrowRight" && cur.ch < N) location.hash = chHref(cur.ch + 1);
  });

  /* ---------- 对外接口 ---------- */
  window.Reader = {
    data: D, chapters: CH, key: K,
    get: get, set: set, getJSON: getJSON, setJSON: setJSON,
    esc: esc, el: el, pad: pad, chHref: chHref, toast: toast, sheet: sheet, flash: flash,
    on: on, emit: emit,
    view: function (name, spec) { VIEWS[name] = spec; },
    current: function () { return cur; },
    maxRead: maxRead,
    scrollToPara: scrollToPara,
    start: function () { applySize(); applyRead(); applyWave(); route(); }
  };
  // features.js 登记完页面后会调用 Reader.start()；没有 features.js 时自己启动
  setTimeout(function () { if (!window.READER_WAIT && !view.firstChild) window.Reader.start(); }, 0);
})();
