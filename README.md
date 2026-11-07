# DeepSeek Harness 导读

模型只会吐字。让它动手的，是 harness。

这是一份第三方中文导读，讲 `deepseek-ai/deepseek-harness` 的运行机制：从「模型与真实世界的边界」开始，到 turn / step、Session 日志、插件模型，最后到组装与设计取舍。面向**会写代码、但没读过 agent 实现的人**。

在线阅读：https://lzwanan.github.io/deepseek-harness-guide/

## 状态

编写中。规划 7 章 28 节，已上线 3 章 11 节。未完成的章节在目录里标「待补」，不写占位正文。

| 章 | 主题 | 节数 | 状态 |
| --- | --- | --- | --- |
| 01 | 它是什么 | 4 | 已上线 |
| 02 | turn 与 step | 3 | 已上线 |
| 03 | Session 日志 | 4 | 已上线 |
| 04 | 插件模型 | 5 | 待补 |
| 05 | 能力缝 | 4 | 待补 |
| 06 | 组装 | 4 | 待补 |
| 07 | 设计取舍 | 4 | 待补 |

## 这不是什么

- 不是 DeepSeek 官方文档，与 DeepSeek 无关联。
- 不是 API 手册。事件名和包路径用于指路，不代替源码。
- 不是课程。没有闯关、没有打卡，按目录跳读即可。

## 内容快照

站内写死了事件名、包路径和源码片段，上游仍在活跃更新。本版核对的是上游 `master` 的 [`fcc0ad4`](https://github.com/deepseek-ai/deepseek-harness/commit/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159)（2026-11-04）。如果读的时候上游已改名，以源码为准，也欢迎提 issue 或 PR 修正。

## 本地阅读

零依赖、零构建、无外部请求。

```bash
python3 -m http.server 8000 -d docs
# 打开 http://localhost:8000
```

也可以直接双击 `docs/index.html`。用 `file://` 打开时部分浏览器会限制 localStorage，主题切换和「接着读」可能不生效。

## 这个站点本身

- 亮 / 暗两套主题，长文优先，单一强调色，规范见 [`DESIGN.md`](DESIGN.md)。
- 三张动效图各讲一件事：顺序、往返、边界。rAF 连续时间轴，支持播放、单步、拖拽、变速；`prefers-reduced-motion` 停在末帧。
- 术语浮层、双目录同步、阅读进度、键盘可达。
- `docs/styleguide.html` 是 `DESIGN.md` 的视觉版，色卡从 `getComputedStyle` 读，不手抄，规范和实现不会漂移。

走查钩子：`?theme=light|dark`、`?freeze=0.42`、`?tip=1`、`?scroll=0.55`、`?q=turn`。

## 许可

| 范围 | 许可 |
| --- | --- |
| 站点代码（`docs/assets/*`、HTML 结构） | MIT，见 [`LICENSE`](LICENSE) |
| 教程文字、术语、`DESIGN.md` | CC BY 4.0，见 [`CONTENT-LICENSE`](CONTENT-LICENSE) |
| 引用的上游源码片段 | MIT，见 [`NOTICE.md`](NOTICE.md) |

转载请保留出处与署名。

## 参与

见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。一句话原则：**讲错比讲浅更糟**，写完先回上游核对事件名和包路径。上游仓库关闭了 Issues，本仓库的 Issues 用来收内容勘误与章节认领。
