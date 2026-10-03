# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root —— 本仓的领域术语表（每个概念给规范词与 `_Avoid_` 列表）。本仓**不使用** `GLOSSARY.md`，也**不要另建**：术语表以 `CONTEXT.md` 为唯一事实源。
- **`docs/adr/`**: read ADRs that touch the area you're about to work in（本仓为单上下文，无 `GLOSSARY-MAP.md`，也无 per-context ADR 目录）。

If a file you'd expect doesn't exist, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. Terms land in `CONTEXT.md` when actually resolved（`/domain-modeling` 走 CONTEXT.md，不新建 GLOSSARY.md）.

## File structure

Single-context repo:

```
/
├── CONTEXT.md          ← 领域术语表（本仓的 GLOSSARY）
├── docs/adr/
│   ├── 0001-live-stepwise-execution.md
│   └── 0002-multi-file-src-layout.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

本仓对这条是机械执法的：门禁 `verify/engine.test.mjs` (f) 段按 `CONTEXT.md` 的 `_Avoid_` 词表计数（基线 `verify/term-baseline.json` 只减不增），界面文案、战斗日志、README、CONTEXT.md 中的违规会被 CI 拦下。

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (live stepwise execution), but worth reopening because…_
