#!/usr/bin/env python3
"""账本三部曲 · 阅读器内核 build.py —— kit v2.0

把一本书的正文（markdown）和它的书目录，生成一个单页阅读站：所有章节、人物、时间线都在 index.html 里，
页面之间用 #ch05、#people 这样的锚点切换。单页是为了让评论、读后感这些要用到 Artifact 能力的功能，
在每一章都能用。

用法：
    python3 build.py <书目录> <正文.md> <输出目录> [--core <内核目录>] [--standalone]

书目录里放：
  book.json        必需。字段见套件说明页
  theme.css        必需。颜色、字体、封面插画的样式
  cover.svg        可选。书封插画
  end.svg          可选。章末小图
  scene.js         可选。自己的章首动画 / 环境声
  characters.json  可选。人物（有了才有“人物”页和正文里的人名卡片）
  timeline.json    可选。时间线（有了才有“时间线”页和章末“本章大事”）
  recaps.json      可选。{"2": "第一章讲了什么", ...}，显示在每章开头的“前情提要”

正文：一章一个 "## 第一章　章名"；空行分段；"---" 分节；"> " 引用（多行排成信）；整段 "*斜体*" 是闪回。

输出：index.html（发布时作主页面）、reader.css、reader.js、features.css、features.js、theme.css、
      scene.js（如有），以及 ch01.html… 这些只做跳转的小页（旧链接还能用）。
--standalone  index.html 写成完整文档，本地预览用；发布到 claude.ai 时不要加。
--no-social   纯静态版：不要评论、读后感、读者主页、作者后台（其他功能都在，不需要任何后端）。
--backend     GitHub Pages 版：加载 Supabase + config.js + backend.js（邮箱验证码登录、评论存在 Supabase），
              分享链接用页面自己的地址。一般和 --standalone 一起用。
"""
import json, re, html, math, os, sys, shutil

KIT = "2.1"


def args():
    a = sys.argv[1:]
    core = os.path.dirname(os.path.abspath(__file__))
    standalone = False
    global BACKEND, SOCIAL
    if "--no-social" in a:
        a.remove("--no-social"); SOCIAL = False
    global SPLIT
    if "--split" in a:
        a.remove("--split"); SPLIT = True
    if "--backend" in a:
        a.remove("--backend"); BACKEND = True
    if "--core" in a:
        i = a.index("--core"); core = a[i + 1]; del a[i:i + 2]
    if "--standalone" in a:
        a.remove("--standalone"); standalone = True
    if len(a) != 3:
        sys.exit(__doc__)
    return a[0], a[1], a[2], core, standalone


BACKEND = False
SOCIAL = True
SPLIT = False   # --split：每章正文单独放在 chapters/chNN.md，网页打开时读取（可以直接在 GitHub 上改字）
SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js"


def parse(md):
    parts = re.split(r"^## ", md, flags=re.M)
    chs = []
    for p in parts[1:]:
        lines = p.split("\n")
        head = lines[0].strip()
        body = "\n".join(lines[1:]).strip()
        blocks = []
        for chunk in re.split(r"\n\s*\n", body):
            c = chunk.strip()
            if not c:
                continue
            if c in ("---", "***", "* * *"):
                blocks.append({"k": "hr"}); continue
            if c.startswith(">"):
                ls = [re.sub(r"^>\s?", "", x).strip() for x in c.split("\n")]
                ls = [x for x in ls if x]
                if blocks and blocks[-1]["k"] == "bq":
                    blocks[-1]["lines"] += ls
                else:
                    blocks.append({"k": "bq", "lines": ls})
                continue
            if c.startswith("*") and c.endswith("*") and not c.startswith("**"):
                blocks.append({"k": "it", "t": c.strip("*")}); continue
            blocks.append({"k": "p", "t": c.replace("\n", "")})
        m = re.match(r"^(第[一二三四五六七八九十百零〇两\d]+章)[\s　]*(.*)$", head)
        title = (m.group(2).strip() if m and m.group(2).strip() else head)
        chs.append({"head": head, "title": title, "blocks": blocks, "raw": "## " + p.strip() + "\n"})
    return chs


NUMS = "零一二三四五六七八九"


def cn(n):
    if n < 10: return NUMS[n]
    if n < 20: return "十" + (NUMS[n % 10] if n % 10 else "")
    if n < 100: return NUMS[n // 10] + "十" + (NUMS[n % 10] if n % 10 else "")
    return str(n)


def quotes(s):
    if s.count('"') % 2 == 0:
        out, open_ = [], True
        for ch in s:
            if ch == '"':
                out.append("“" if open_ else "”"); open_ = not open_
            else:
                out.append(ch)
        s = "".join(out)
    return s


def count(s):
    return len(re.sub(r"\s", "", s))


def strip_q(s):
    return s.strip('"“”「」')


WAVES_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/><path d="M2 14c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/><path d="M2 19c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/></svg>'
ICON = {
    "search": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>',
    "shelf": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
}


def main():
    book_dir, src, out, core, standalone = args()
    B = json.load(open(os.path.join(book_dir, "book.json"), encoding="utf-8"))
    chs = parse(open(src, encoding="utf-8").read())
    N = len(chs)
    if not N:
        sys.exit("正文里没找到 “## ” 开头的章标题")
    os.makedirs(out, exist_ok=True)

    def opt(name):
        p = os.path.join(book_dir, name)
        return open(p, encoding="utf-8").read().strip() if os.path.exists(p) else ""

    def optjson(name):
        t = opt(name)
        return json.loads(t) if t else None

    cover_svg, end_svg = opt("cover.svg"), opt("end.svg")
    people = optjson("characters.json")
    timeline = optjson("timeline.json")
    recaps = optjson("recaps.json") or {}
    has_scene_js = os.path.exists(os.path.join(book_dir, "scene.js"))
    key = B["key"]
    title_book = B["title"]
    tones = B["tones"]
    tone_ids = [t["id"] for t in tones]
    light, dark = B.get("light", tone_ids[0]), B.get("dark", tone_ids[-1])
    head_cfg = B.get("head") or {}
    head_scene = head_cfg.get("scene", "none")
    snd_cfg = B.get("sound") or {}
    snd_scene = snd_cfg.get("scene", "none")
    era = {int(k): v for k, v in ((B.get("era") or {}).get("chapters") or {}).items()}
    coda_ch = (B.get("coda") or {}).get("chapter")
    italic_cls = B.get("italic_class", "echo")
    sign_pref = tuple((B.get("letter") or {}).get("sign_prefixes") or [])

    special = {}
    for cls, items in (B.get("specials") or {}).items():
        for t in items:
            special[t] = cls
    used = set()

    # 人名标记：每章每人第一次出现，包一层可点的 <b class="rn">
    marks = []
    if people:
        for pp in people["people"]:
            for m in pp.get("mark") or [pp["name"]]:
                marks.append((m, pp["id"]))
    marks.sort(key=lambda x: -len(x[0]))
    mark_re = re.compile("|".join(re.escape(m) for m, _ in marks)) if marks else None
    mark_id = dict(marks)

    def render_chapter(i, c):
        seen = set()
        paras = []          # 每个 data-p 的纯文本
        body = []

        def txt(raw, cls=None, tag="p"):
            k = len(paras)
            paras.append(quotes(raw))
            s = html.escape(quotes(raw), quote=False)
            if mark_re and not (cls or "").startswith("msg"):
                def rep(m):
                    pid = mark_id[m.group(0)]
                    if pid in seen:
                        return m.group(0)
                    seen.add(pid)
                    return '<b class="rn" data-c="%s">%s</b>' % (pid, m.group(0))
                s = mark_re.sub(rep, s)
            attr = ' class="%s"' % cls if cls else ""
            return '<%s%s data-p="%d">%s</%s>' % (tag, attr, k, s, tag)

        def para(t):
            cls = special.get(t)
            if not cls:
                return txt(t)
            used.add(t)
            return txt(strip_q(t) if cls.startswith("msg") else t, cls)

        def letter(lines):
            if len(lines) == 1 and lines[0] in special:
                return para(lines[0])
            o = ['<blockquote class="xin">']
            for j, t in enumerate(lines):
                if sign_pref and t.startswith(sign_pref):
                    o.append(txt(t, "sign"))
                elif j == 0 and t.endswith("："):
                    o.append(txt(t, "to"))
                elif t in special:
                    o.append(para(t))
                else:
                    o.append(txt(t))
            o.append("</blockquote>")
            return "\n".join(o)

        n = 0
        blocks = c["blocks"]
        last_hr = max([k for k, b in enumerate(blocks) if b["k"] == "hr"], default=-1) if i == coda_ch else -1
        for k, b in enumerate(blocks):
            if b["k"] == "hr":
                body.append('<div class="brk" aria-hidden="true"><i></i><i></i><i></i></div>')
            elif b["k"] == "bq":
                n += sum(count(x) for x in b["lines"]); body.append(letter(b["lines"]))
            elif b["k"] == "it":
                n += count(b["t"]); body.append(txt(b["t"], italic_cls))
            else:
                n += count(b["t"])
                if i == coda_ch and k > last_hr >= 0:
                    body.append(txt(b["t"], "coda"))
                else:
                    body.append(para(b["t"]))
        return "\n".join(body), paras, n

    chapters = []
    for i, c in enumerate(chs, 1):
        body, paras, n = render_chapter(i, c)
        chapters.append({"n": i, "cn": cn(i), "title": c["title"], "era": era.get(i, ""),
                         "chars": n, "mins": max(1, math.ceil(n / 400)), "html": body, "paras": paras,
                         "recap": recaps.get(str(i), "")})

    unused = set(special) - used
    if unused:
        print("提醒：这些 specials 在正文里没找到（原文改过？）：")
        for t in sorted(unused): print("   ", t)

    total = sum(c["chars"] for c in chapters)
    data = {
        "kit": KIT, "key": key, "title": title_book,
        "series": B.get("series", ""), "series_no": B.get("series_no", ""),
        "desc": B.get("desc", ""), "blurb": B.get("blurb", ""), "epigraph": B.get("epigraph"),
        "foot": B.get("foot", title_book), "share_url": "" if (BACKEND or not SOCIAL) else B.get("share_url", ""), "social": SOCIAL,
        "series_nav": B.get("series_nav") or [],
        "era_legend": (B.get("era") or {}).get("legend", ""), "legend_now": B.get("legend_now", ""),
        "toc_note_extra": B.get("toc_note_extra", ""), "gauge": B.get("gauge", ""),
        "total": total, "cover": cover_svg, "end": end_svg,
        "people": people, "timeline": timeline,
        "chapters": [] if SPLIT else chapters,
    }

    cfg = {"key": key, "tones": tone_ids, "light": light, "dark": dark, "head": head_scene, "sound": snd_scene}
    prepaint = ("<script>(function(){try{var d=document.documentElement,k=%s,r=localStorage.getItem(k+'.tone');"
                "if(%s.indexOf(r)>=0)d.setAttribute('data-read',r);var f=localStorage.getItem(k+'.fs');"
                "if(f)d.style.setProperty('--fs',f+'px');if(localStorage.getItem(k+'.wave')==='off')d.setAttribute('data-wave','off');}catch(e){}})();</script>"
                % (json.dumps(key), json.dumps(tone_ids)))
    fonts = ""
    if B.get("fonts_url"):
        fonts = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
                 '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
                 '<link rel="stylesheet" href="%s">\n' % html.escape(B["fonts_url"]))

    snd_btn = ""
    if snd_scene != "none":
        lbl = snd_cfg.get("label", "环境声")
        snd_btn = ('<button class="tool" id="snd" type="button" aria-pressed="false" aria-label="%s">%s<span class="tool-l">%s</span></button>'
                   % (html.escape(snd_cfg.get("aria", lbl)), snd_cfg.get("icon_svg", WAVES_ICON), html.escape(lbl)))
    sws = "\n".join('      <button class="sw" type="button" data-read="%s" aria-pressed="false"><i style="background:%s;color:%s">字</i>%s</button>'
                    % (t["id"], t["bg"], t["ink"], html.escape(t["name"])) for t in tones)
    wave_row = ""
    if head_scene != "none":
        lb = html.escape(head_cfg.get("label", "章首动画"))
        wave_row = ('  <div class="switch-row">\n    <span class="set-label">%s</span>\n'
                    '    <button class="switch" id="waveSw" type="button" role="switch" aria-checked="true" aria-label="%s"></button>\n  </div>\n' % (lb, lb))
    panel = ('<div class="panel" id="panel" role="dialog" aria-label="阅读设置" hidden>\n'
             '  <div>\n    <span class="set-label">底色</span>\n    <div class="swatches" style="grid-template-columns:repeat(%d,1fr)">\n%s\n    </div>\n  </div>\n'
             '  <div>\n    <span class="set-label">字号</span>\n    <div class="stepper">\n'
             '      <button type="button" data-step="-1" aria-label="字小一号"><span class="s">A</span></button>\n'
             '      <output aria-live="polite">19 号</output>\n'
             '      <button type="button" data-step="1" aria-label="字大一号"><span class="l">A</span></button>\n'
             '    </div>\n  </div>\n%s'
             '  <p class="panel-note">%s</p>\n</div>'
             % (len(tones), sws, wave_row, html.escape(B.get("panel_note", ""))))
    desc = html.escape(B.get("desc", ""))
    gauge = ""
    if B.get("gauge"):
        gauge = ('<aside class="gauge" aria-hidden="true" hidden>\n  <span class="g-t"><b>%s</b>　%s</span>\n  <span class="g-col"><i></i></span>\n</aside>'
                 % (html.escape(title_book), html.escape(B["gauge"])))
    # 数据里的 </script> 要转义，免得提前结束 script 标签
    if SPLIT:
        data["split"] = {
            "count": N, "era": {str(k): v for k, v in era.items()}, "coda": coda_ch, "italic": italic_cls,
            "sign": list(sign_pref), "specials": special, "marks": marks,
            "recaps": {str(c["n"]): c["recap"] for c in chapters if c["recap"]},
        }
        os.makedirs(os.path.join(out, "chapters"), exist_ok=True)
        os.makedirs(os.path.join(out, "data"), exist_ok=True)
        for f in ("book.json", "characters.json", "timeline.json", "recaps.json", "cover.svg"):
            if os.path.exists(os.path.join(book_dir, f)):
                shutil.copy(os.path.join(book_dir, f), os.path.join(out, "data", f))
        for i, c in enumerate(chs, 1):
            open(os.path.join(out, "chapters", "ch%02d.md" % i), "w", encoding="utf-8").write(c["raw"])
    data_json = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")

    index = f"""<title>{html.escape(title_book)}</title>
<meta name="description" content="{desc}">
<meta name="claude:viewport-fit-sides" content="cover">
{prepaint}
{fonts}<link rel="stylesheet" href="reader.css">
<link rel="stylesheet" href="features.css">
<link rel="stylesheet" href="theme.css">
<div class="page" id="app" data-ch="0">
<header class="bar">
  <a class="bar-home" id="barHome" href="#"><span class="bar-mark">{html.escape(title_book)}</span></a>
  <div class="bar-mid" aria-hidden="true"></div>
  <div class="bar-tools">
    <button class="tool" id="findBtn" type="button" aria-label="全文搜索">{ICON['search']}</button>
    {snd_btn}
    <button class="tool" id="aa" type="button" aria-expanded="false" aria-controls="panel" aria-label="阅读设置"><span class="aa">Aa</span></button>
    <a class="tool" id="shelfBtn" href="#shelf" aria-label="我的书房">{ICON['shelf']}</a>
  </div>
  <div class="bar-prog" aria-hidden="true"><i></i></div>
</header>
{panel}
<main id="view"></main>
{gauge}
</div>
<script type="application/json" id="book-data">{data_json}</script>
<script>window.BOOK={json.dumps(cfg, ensure_ascii=False)};</script>
{'<script src="scene.js"></script>' if has_scene_js else ''}
{('<script src="' + SUPABASE_JS + '"></script>' + chr(10) + '<script src="config.js"></script>' + chr(10) + '<script src="backend.js"></script>') if BACKEND else ''}
{'<script src="loader.js"></script>' if SPLIT else '<script src="reader.js"></script>' + chr(10) + '<script src="features.js"></script>'}
"""
    if standalone:
        index = ('<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
                 '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n'
                 + index + "</body>\n</html>\n")
    open(os.path.join(out, "index.html"), "w", encoding="utf-8").write(index)

    # 旧的分章链接：跳回单页
    for c in chapters:
        stub = ('<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width, initial-scale=1">'
                '<title>第%s章　%s · %s</title>'
                '<script>location.replace("index.html#ch%02d")</script></head>'
                '<body><p><a href="index.html#ch%02d">第%s章　%s</a></p></body></html>\n'
                % (c["cn"], html.escape(c["title"]), html.escape(title_book), c["n"], c["n"], c["cn"], html.escape(c["title"])))
        open(os.path.join(out, "ch%02d.html" % c["n"]), "w", encoding="utf-8").write(stub)

    for f in ("reader.css", "reader.js", "features.css", "features.js") + (("loader.js",) if SPLIT else ()):
        shutil.copy(os.path.join(core, f), os.path.join(out, f))
    shutil.copy(os.path.join(book_dir, "theme.css"), os.path.join(out, "theme.css"))
    if has_scene_js:
        shutil.copy(os.path.join(book_dir, "scene.js"), os.path.join(out, "scene.js"))
    if BACKEND:
        shutil.copy(os.path.join(core, "backend.js"), os.path.join(out, "backend.js"))
        cfg_path = os.path.join(out, "config.js")
        if not os.path.exists(cfg_path):
            open(cfg_path, "w", encoding="utf-8").write(
                "// 换成你自己 Supabase 项目的地址和 anon key（Project Settings → API）。anon key 本来就是公开的，可以放进仓库。\n"
                "window.READER_BACKEND = {\n  url: \"https://你的项目.supabase.co\",\n  anonKey: \"你的 anon key\"\n};\n")
        open(os.path.join(out, ".nojekyll"), "w").write("")

    print("《%s》%d 章，%s 字 → %s（index.html %d KB）" % (title_book, N, format(total, ","), out,
                                                       os.path.getsize(os.path.join(out, "index.html")) // 1024))


if __name__ == "__main__":
    main()
