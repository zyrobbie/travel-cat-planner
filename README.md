# 旅行小猫 · travel-cat-planner

一款心理陪伴型产品的项目规划文档站，由 GitHub Pages 托管。

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
| `idea` | `docs/idea.md` | 《旅行小猫初始想法》 |
| `manual` | `docs/manual.md` | 旅行小猫项目执行总纲（v1.1 已审定） |
| `phase1-summary` | `docs/phase1-summary.md` | Phase 1 调研汇总（概念收敛会材料包） |
| `report-competitive` | `docs/report-competitive.md` | 竞品全景调研报告（线 A · 竞析） |
| `report-market` | `docs/report-market.md` | 赛道数据分析报告（线 C · 数析） |
| `report-user` | `docs/report-user.md` | 目标用户研究综合报告（线 B · 瑞思） |

## 更新方式

文档更新：替换 `docs/` 下对应 md 文件 → commit → push，Pages 自动重新部署，无需改 HTML。

> 由产品战略团队 AI 协作推进 · 重要决策由产品负责人审定
