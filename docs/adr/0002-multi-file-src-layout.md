# 多文件 src/ 构成而非单文件 index.html

功能会沿三条轴持续增加（战斗内容、呈现演出、玩法模式），单文件 index.html 的「管理重量」成为预期瓶颈。决定把代码拆到 `src/`（styles.css / engine.js / ui.js），`index.html` 只留两页骨架与 `<link>` / `<script src>` 引用。玩家侧不变量原样保留：零外部依赖、无构建步骤、`file://` 双击即开（普通 `<script src>` 在 file:// 下可用）；工程不变量原样保留：引擎仍是 `window.GameEngine` 纯函数 + 可注入 RNG，`src/engine.js` 顶部注释块继续作为 GameEngine / GameUI 的 API 文档，「同种子一致」由 `verify/engine.test.mjs` 锁死（引擎提取目标从 index.html 改为 src/engine.js，断言语义一条不减）。代价：不再存在「单文件产物」这一分享形态，对已发布 GitHub 的项目无实际损失。

## Considered Options

- **严格单文件 + 内部分区升级（被否）**：不动约束最省事，但不解决文件重量本身，与本次目标（持续加功能后仍好管理）不符。
- **源码多文件 + 极简拼接脚本产出单文件（被否）**：多养一套拼接脚本；「单文件产物便于分享」的价值对已发布仓库无意义。
- **ES modules 多文件（被否）**：file:// 下需本地服务器，丢「双击即开」。
- **多文件 `<script src>` + `src/` 目录（采纳）**：本 ADR 的决定，零构建、零依赖、双击即开全部保持，后续功能有明确去处（数值 → 配置与数据；演出 → `src/ui.js`、`src/styles.css`；行为 → 规格先行进 `src/engine.js`）。
