/* 账本三部曲 · 分章加载 loader.js
 * 正文放在 chapters/ch01.md … 里，可以直接在 GitHub 上改字。
 * 网页打开时读取这些文件、排好版，再启动 reader.js 和 features.js。
 * 写法和以前一样：第一行 “## 第一章　章名”；空行分段；--- 分节；> 开头是信；整段 *斜体* 是闪回。
 */
(function () {
  "use strict";
  var box = document.getElementById("book-data");
  var D = JSON.parse(box.textContent);
  var S = D.split;
  var NUMS = "零一二三四五六七八九";
  function cn(n) {
    if (n < 10) return NUMS[n];
    if (n < 20) return "十" + (n % 10 ? NUMS[n % 10] : "");
    return NUMS[Math.floor(n / 10)] + "十" + (n % 10 ? NUMS[n % 10] : "");
  }
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function quotes(s) {
    if ((s.match(/"/g) || []).length % 2) return s;
    var open = true;
    return s.replace(/"/g, function () { var q = open ? "“" : "”"; open = !open; return q; });
  }
  function count(s) { return s.replace(/\s/g, "").length; }
  var markRe = null, markId = {};
  function setMarks(list) {
    var marks = list.slice().sort(function (a, b) { return b[0].length - a[0].length; });
    markRe = marks.length ? new RegExp(marks.map(function (m) { return m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|"), "g") : null;
    markId = {}; marks.forEach(function (m) { markId[m[0]] = m[1]; });
  }
  setMarks(S.marks || []);

  function parse(md) {
    md = md.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
    var lines = md.split("\n"), head = "";
    while (lines.length && !lines[0].trim()) lines.shift();
    if (lines.length && /^##\s/.test(lines[0])) head = lines.shift().replace(/^##\s*/, "").trim();
    var blocks = [];
    lines.join("\n").trim().split(/\n\s*\n/).forEach(function (chunk) {
      var c = chunk.trim();
      if (!c) return;
      if (c === "---" || c === "***" || c === "* * *") { blocks.push({ k: "hr" }); return; }
      if (c[0] === ">") {
        var ls = c.split("\n").map(function (x) { return x.replace(/^>\s?/, "").trim(); }).filter(Boolean);
        var last = blocks[blocks.length - 1];
        if (last && last.k === "bq") last.lines = last.lines.concat(ls); else blocks.push({ k: "bq", lines: ls });
        return;
      }
      if (c[0] === "*" && c[c.length - 1] === "*" && c.slice(0, 2) !== "**") { blocks.push({ k: "it", t: c.replace(/^\*+|\*+$/g, "") }); return; }
      blocks.push({ k: "p", t: c.replace(/\n/g, "") });
    });
    var m = /^(第[一二三四五六七八九十百零〇两\d]+章)[\s　]*(.*)$/.exec(head);
    return { title: (m && m[2].trim()) || head, blocks: blocks };
  }

  function render(n, c) {
    var seen = {}, paras = [], body = [], chars = 0;
    function txt(raw, cls) {
      var k = paras.length;
      paras.push(quotes(raw));
      var s = esc(quotes(raw));
      if (markRe && !/^msg/.test(cls || "")) {
        s = s.replace(markRe, function (w) {
          var id = markId[w];
          if (seen[id]) return w;
          seen[id] = 1;
          return '<b class="rn" data-c="' + id + '">' + w + "</b>";
        });
      }
      return "<p" + (cls ? ' class="' + cls + '"' : "") + ' data-p="' + k + '">' + s + "</p>";
    }
    function para(t) {
      var cls = S.specials[t];
      if (!cls) return txt(t);
      return txt(/^msg/.test(cls) ? t.replace(/^["“”「」]+|["“”「」]+$/g, "") : t, cls);
    }
    function letter(ls) {
      if (ls.length === 1 && S.specials[ls[0]]) return para(ls[0]);
      var o = ['<blockquote class="xin">'];
      ls.forEach(function (t, j) {
        if (S.sign.some(function (p) { return t.indexOf(p) === 0; })) o.push(txt(t, "sign"));
        else if (j === 0 && /：$/.test(t)) o.push(txt(t, "to"));
        else if (S.specials[t]) o.push(para(t));
        else o.push(txt(t));
      });
      o.push("</blockquote>");
      return o.join("\n");
    }
    var lastHr = -1;
    if (n === S.coda) c.blocks.forEach(function (b, k) { if (b.k === "hr") lastHr = k; });
    c.blocks.forEach(function (b, k) {
      if (b.k === "hr") body.push('<div class="brk" aria-hidden="true"><i></i><i></i><i></i></div>');
      else if (b.k === "bq") { b.lines.forEach(function (x) { chars += count(x); }); body.push(letter(b.lines)); }
      else if (b.k === "it") { chars += count(b.t); body.push(txt(b.t, S.italic)); }
      else { chars += count(b.t); body.push(n === S.coda && lastHr >= 0 && k > lastHr ? txt(b.t, "coda") : para(b.t)); }
    });
    return { n: n, cn: cn(n), title: c.title, era: S.era[String(n)] || "", chars: chars, mins: Math.max(1, Math.ceil(chars / 400)),
      html: body.join("\n"), paras: paras, recap: S.recaps[String(n)] || "" };
  }

  function load(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.body.appendChild(s);
    });
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function get1(f, type) {
    return fetch(f, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(f); return type === "json" ? r.json() : r.text(); });
  }
  // 先找 chapters/ 或 data/ 文件夹里的；网页上传时文件夹被拆平了的话，就在根目录找同名文件
  function get(f, type) {
    return get1(f, type).catch(function (e) { var b = f.split("/").pop(); if (b === f) throw e; return get1(b, type); });
  }
  function opt(f, type) { return get(f, type).catch(function (e) { if (window.console) console.warn("没读到 " + f + "，用网页里原来的那份。", e); return null; }); }
  // data/ 里的几个文件可以直接在 GitHub 上改；没读到（或格式写错）就用网页里原来的那份
  Promise.all([opt("data/book.json", "json"), opt("data/characters.json", "json"), opt("data/timeline.json", "json"), opt("data/recaps.json", "json"), opt("data/cover.svg")]).then(function (r) {
    var B = r[0];
    if (B) {
      ["title", "series", "series_no", "desc", "blurb", "epigraph", "foot", "toc_note_extra", "series_nav", "legend_now"].forEach(function (k) { if (B[k] !== undefined) D[k] = B[k]; });
      if (B.era) { if (B.era.legend !== undefined) D.era_legend = B.era.legend; if (B.era.chapters) S.era = B.era.chapters; }
      if (B.coda) S.coda = B.coda.chapter;
      if (B.italic_class) S.italic = B.italic_class;
      if (B.letter && B.letter.sign_prefixes) S.sign = B.letter.sign_prefixes;
      if (B.specials) { S.specials = {}; Object.keys(B.specials).forEach(function (cls) { B.specials[cls].forEach(function (t) { S.specials[t] = cls; }); }); }
    }
    if (r[1]) {
      D.people = r[1];
      var ms = [];
      (r[1].people || []).forEach(function (p) { (p.mark || [p.name]).forEach(function (m) { ms.push([m, p.id]); }); });
      setMarks(ms);
    }
    if (r[2]) D.timeline = r[2];
    if (r[3]) S.recaps = r[3];
    if (r[4]) D.cover = r[4].trim();
    var files = [];
    for (var i = 1; i <= S.count; i++) files.push("chapters/ch" + pad(i) + ".md");
    return Promise.all(files.map(function (f) { return get(f); }));
  }).then(function (texts) {
    D.chapters = texts.map(function (t, i) { return render(i + 1, parse(t)); });
    D.total = D.chapters.reduce(function (s, c) { return s + c.chars; }, 0);
    box.textContent = JSON.stringify(D);
    window.READER_WAIT = true;   // 等 features.js 加载完再启动
    return load("reader.js");
  }).then(function () { return load("features.js"); }).catch(function (e) {
    var v = document.getElementById("view");
    if (v) v.innerHTML = '<p style="padding:40px 20px;text-align:center">正文没有加载出来（' + String(e && e.message || e) + '）。请刷新一下；如果是直接双击打开的本地文件，需要放到网站上才能读取。</p>';
  });
})();
