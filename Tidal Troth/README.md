# 潮信 · 网页阅读版

纯静态网页，放 GitHub Pages 即可。

## 改正文

正文在 `chapters/` 文件夹里，一章一个文件：`ch01.md` 是第一章，`ch20.md` 是第二十章。

在 GitHub 上点开那一章 → 右上角铅笔图标（Edit）→ 直接改字 → 页面底部 **Commit changes**。一两分钟后网页自动更新。

写法规则（照原样保持即可）：

- 第一行 `## 第一章　章名`，改这里就是改章名。
- 段与段之间空一行。
- 单独一行 `---` 是分节的三个小圆点。
- 以 `>` 开头的行排成信件。
- 整段用 `*` 包起来（`*这样*`）是蓝色的闪回段。

## 上线

1. 新建仓库，把这个文件夹里的全部文件传到仓库根目录。
2. Settings → Pages → Source 选 Deploy from a branch，分支 `main`，目录 `/ (root)`，保存。

注意：直接双击本地的 index.html 打不开正文，要放到网站上才行。

## data/ 里的文件（也能在 GitHub 上直接改）

| 文件 | 管什么 |
|---|---|
| `data/book.json` | 书封文字：书名、简介（blurb）、题记（epigraph）、页脚、三部曲导航链接，以及哪些句子排成账本、手写、消息气泡（specials） |
| `data/characters.json` | 人物卡：简介（intro）、身份（role）、关键事件（events）、关系（rel） |
| `data/timeline.json` | 时间线：每个事件的日期（d）、标题（t）、说明（s）、所在章（ch） |
| `data/recaps.json` | 前情提要：`"5": "……"` 就是第五章开头显示的那段 |
| `data/cover.svg` | 书封插画 |

只改引号里的中文，引号、逗号、括号保持原样。改坏了网页也不会白屏，会先用原来那份，改对了再生效。

## 其余文件

| 文件 | 作用 |
|---|---|
| `index.html` | 网页入口 |
| `loader.js` | 读取 chapters/ 和 data/，排版后交给阅读器 |
| `reader.js` / `reader.css` | 阅读器：目录、翻章、续读、底色字号、章首潮水、听潮 |
| `features.js` / `features.css` | 划线批注、书签、搜索、人物、时间线、前情提要、金句卡、我的书房 |
| `theme.css` | 《潮信》的配色和字体 |
| `ch01.html`…`ch20.html` | 旧链接跳转用，不用管 |
| `source/core/` | 生成网页的脚本，只有改配色、字体这类才需要 |
