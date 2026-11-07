# 参与编写

## 一条硬规则：可验证

每句话都应该能在上游源码里找到对应位置。判断标准只有一条：**这句话能不能被验证**。
写不出处的形容词（强大、高效、灵活）直接删。教学站讲错比讲浅更糟。

## 补一章 / 一节之前

1. 先核对上游当前 `master`，在 PR 里写明你核对的 commit SHA。
2. 事件名、方法名、包路径逐个搜源码，不要照着印象写。本项目修过三处这类错误：
   `llm/stream` → `agent/request`、`tools/execute` → `ctx.tools.execute()`、
   `assistant_text` → `assistant/message`。
3. 照 `DESIGN.md` 第 8 节的骨架写：eyebrow → h1 → lede → figure → figcap → 代码 → recap → check。
   一节只加一个新概念；图在概念之后、代码之前；节末三行 recap 各写一个可验证事实。
4. 一张图只讲一件事，坐标走 16px 网格，先定容器宽再定 viewBox。

## 文案

- 短句，一句一个动作；陈述句加句号。
- 术语先中文，括号英文；给具体数字，不给「多种 / 若干」。
- 不用感叹号、emoji、🚀，不写「让我们一起」。
- 标题可以用一个比喻，正文第一段就翻译成机制。
- 图注回答「怎么用 / 怎么读 / 边界」，不复述图上的字。

完整红线见 `DESIGN.md` 第 9、10 节。

## 本地运行与走查

```bash
python3 -m http.server 8000 -d docs
```

- `node --check docs/assets/site.js && node --check docs/assets/figures.js`
- 亮 / 暗各截一轮：`?theme=light`、`?theme=dark`
- 动画定帧：`?freeze=0.42`；桌面 1280、窄屏 500
- 窄屏下图保持最小宽 560px 并允许横向滑动，不要等比缩到字看不清

## 提交

- 一个 PR 只改一节，或只修一类问题；写清核对过的上游 commit。
- 内容勘误优先于新增章节。
- 不要提交本地截图、探针页、编辑器配置或工作区内部数据，见 `.gitignore`。
