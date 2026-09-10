# 工作日程

单人的本地工作日程管理应用：每日计划 → 推进记录 → 当日成果 → 跨天承接 → 周回顾。  
真实后端 + SQLite 持久化，非静态演示。数据全部保存在本机，无云端同步、零第三方依赖。

## 快速开始

**自带 Node 运行时，不依赖外部环境**（也不依赖任何 IDE）：

```bash
runtime\node.exe server\index.js   # 或 npm start（用 PATH 上的 node，需 >= 22.5）
# 打开 http://127.0.0.1:5173
runtime\node.exe --test tests/     # 17 个自动化用例
```

- 运行时：`runtime/node.exe`（v22.22.2，84MB，随项目放置，**不入库**）。缺失时重新生成：`python tools/setup_runtime.py`（自动找本机 Node）或加 `--download`（从 nodejs.org 拉官方包）。
- 启动器查找顺序：`runtime\node.exe` → PATH 上的 `node`，两者都没有才失败。

Windows 桌面快捷方式 **「工作日程」**（图标可用 `--icon` 指定）：双击自动拉起服务并打开浏览器。  
重新生成：`python tools/make_shortcut.py`（需 `pip install pylnk3`）；兜底：双击 `启动服务.bat`。  
实测服务冷启动到就绪约 **530ms**（`python tools/measure_start.py`），其余等待主要来自浏览器冷启动。

环境变量：`PORT`(5173)、`HOST`(127.0.0.1)、`WORKDAY_DATA_DIR`(数据目录)、`TZ`、`WORKDAY_NOW`(测试固定"今天")。

## 结构

|    |                                                                   |
| -- | ----------------------------------------------------------------- |
| 后端 | Node 原生 `node:http` + `node:sqlite`（WAL），REST API，零依赖             |
| 前端 | 原生 ES Module 单页应用，无构建；桌面双栏 / 移动端单列                                |
| 数据 | `data/workday.db`、附件 `data/attachments/`、备份 `data/backups/`（均不入库） |

主要实体：Task、DailyPlan（日期↔任务，`UNIQUE(task_id, biz_date)`）、ProgressLog、Achievement、Blocker、Attachment、AuditLog、Settings。

## 关键行为

- **跨天继承**：仅在打开当天时触发，为任务新建当日关联（`source=carry`）而非复制任务；已完成/取消/延期未到期/已移出今日不继承；幂等键 + 唯一约束，反复刷新不重复。顺延计数：自上次计划以来无进度且无成果才 +1，达阈值（默认 3）提示拆分。
- **每日快照独立**：今天推到 80%，昨天的日末快照仍为 60%；历史快照可显式修正并留痕，不改写任务当前进度。
- **一致性**：写操作走事务；文本编辑 800ms 防抖自动保存并显示状态；乐观锁版本号，旧版本提交返回 409 不静默覆盖；删除进回收站。
- **备份**：数据管理页导出 ZIP（backup.json + 附件 + manifest）；导入前校验预览，支持合并导入或覆盖恢复（自动先备份）。`schemaVersion` 版本化迁移，升级保留记录。

## 边界

无多人协作/审批/权限；浏览器通知仅在页面打开时有效；数据仅在本机，跨设备靠备份 ZIP 手工迁移；阻碍不会自动通知协作人。

截图见 `docs/`。

