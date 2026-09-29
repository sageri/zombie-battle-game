# AGENTS.md — zombie-battle-game

丧尸 vs 人类自动战斗器：`index.html` + `src/`（配置页⇄战场页，逐行动实时演出）。玩法规则见 `README.md`，领域词汇以 `CONTEXT.md` 为准。

## 硬约束（一切改动的边界）

- 零外部依赖、无构建步骤、file:// 双击即开；不引入网络请求、存储、音效。代码放 `src/`（`index.html` 只留页面骨架与引用），单文件不是目标（见 `docs/adr/0002`）。
- 范围外清单（用户明确不做）：音效、存档、多场战斗管理、设置菜单。收到涉及它们的需求先向用户确认，不顺手实现。
- 战斗规则、数值边界、配置校验语义、日志内容格式是冻结面：呈现层可以随便改，这些一行不动。需求要动冻结面时，先立规格让用户确认。

## 架构不变量

- 引擎与 DOM 分离：`window.GameEngine` 纯函数 + 可注入 RNG；`window.GameUI` 承载界面，演出时延经可注入调度器（测试注入同步调度器）。
- **同种子一致**：同一种子下「整场结算 ≡ 逐步执行」的终局与日志逐条相同。任何引擎改动后这条必须仍成立——`verify/engine.test.mjs` 的一致性套件就是执法者。
- 呈现采用步进而非整场回放，理由与被否方案见 `docs/adr/0001-live-stepwise-execution.md`；动过「改成预计算回放」的念头时先读它。
- 扩展去向与验收：数值/配置类新增进配置与数据，加完门禁绿即算完成；演出类进 `src/ui.js`、`src/styles.css`；行为类（改结算流程）先立规格动冻结面，落地后改动局限在明确接缝、门禁绿。

## 术语

界面文案、战斗日志、README、提交信息一律用 `CONTEXT.md` 术语表的规范词（阵营、角色、倒地、行动顺序、战场、顺序带、飘字、跳到结果…）。_Avoid_ 列的词（成员、单位、先攻、回放…）在这些产出物里同样回避；存量违规点以 main 现状为基线，只减不增。

## 验证（改完必跑）

1. **门禁**：`node verify/engine.test.mjs` → 末行 `RESULT {"assertions":N,"failures":[]}` 且 exit 0。测试只加不删：弱化或删除既有断言视为回退。
2. UI / 演出改动加跑：`node verify/browser-drive.mjs`（Edge 无头 CDP，零依赖；Edge 位于 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，本机无 playwright/puppeteer，CDP 走 Node 24 内置 WebSocket）。`verify/screenshots/` 截图是入库证据，界面变了要重新生成并提交。
3. 完成判据：门禁 exit 0；涉 UI 则浏览器实测全步通过、新截图入库。

## 交付

- 功能与修复走 gitflow：feature 分支 → 原子 Conventional Commits → PR（正文附验证证据）→ 门禁绿即合并（单人公开仓库）→ 删分支、同步 main。
- 功能级改动先立规格 issue（`ready-for-agent` 标签），PR 用 `Closes #N` 关联；架构取舍落 `docs/adr/`。

## 语言

- 代码注释：日文。界面文案与战斗日志：简体中文。README：简体中文。提交标题：英文 Conventional Commits（与现有历史一致）。
