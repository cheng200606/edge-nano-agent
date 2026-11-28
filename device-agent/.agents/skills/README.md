# 技能包（skills）

对应指南第 9 章：每个技能是一个目录，目录里放一份 `SKILL.md`。

```
.agents/skills/
└─ <skill-name>/
   └─ SKILL.md        # 前置元信息 + 指引正文
```

## 约定

`SKILL.md` 首部是极简 YAML front matter：

```markdown
---
name: device-triage
description: 当用户报告设备异常时，按此流程定位问题
---

## 何时使用
...

## 步骤
1. 先用 inspect_device 看当前状态
2. 再查最近的 device_events
...
```

## 状态

**M8 / LU-10 才实现加载器**（`agent/skills/index.ts`）。当前阶段：

- 工具描述符里已经登记了 `use_skill`（`packages/shared/src/agent-tool-descriptor.ts`），
  但它还没有真实实现；
- 本目录作为占位存在，避免"文档说支持技能、但仓库里连目录都没有"。

不要在这个目录里放与技能无关的文件——加载器会遍历子目录，非技能目录会被判为格式错误。
