# 有猫来信 · travel-cat-planner

一款心理陪伴型产品的项目规划文档站，由 GitHub Pages 托管。

**产品名称**：有猫来信（2026-09-09 定名，原名「旅行小猫」）
**线上地址**：https://zyrobbie.github.io/travel-cat-planner/

## 站点结构

| 页面 | 文件 | 说明 |
|------|------|------|
| 目录页 | `index.html` | 项目规划文档总目录（首页） |
| 文档阅读器 | `doc.html?doc=<key>` | 统一渲染 `docs/` 下的 md 文件 |
| 待决策议题 | `decisions.html` | 选择题选项卡 + 开放题作答，生成「问题+答案」汇总页供截图 |

## 文档源文件（docs/）

| key | 文件 | 内容 |
|-----|------|------|
| `idea` | `docs/idea.md` | 《有猫来信初始想法》V2.1（项目逻辑基准） |
| `manual` | `docs/manual.md` | 有猫来信项目执行总纲 V2.1（单一事实来源） |

## 更新方式

文档更新：替换 `docs/` 下对应 md 文件 → commit → push，Pages 自动重新部署，无需改 HTML。

> 由产品战略团队 AI 协作推进 · 重要决策由产品负责人审定
