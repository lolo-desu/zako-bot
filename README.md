# ZakoBot Fork Notes

原项目：[`Mooooooon/zako-bot`](https://github.com/Mooooooon/zako-bot)

这个仓库的 README 只记录当前 fork 相对原项目新增或调整的内容；原项目已有的通用介绍、安装与基础使用说明请直接查看 upstream。

## 当前 fork 新增能力

### Discord 会话模型

- 使用 `thread = session` 组织 Discord 会话
- 在普通频道里直接 `@bot`，会自动创建新的子区并把该消息作为首条会话消息
- `/new` 会始终新开一个独立会话和子区
- `/stop` 会停止当前频道或当前子区中的进行中/排队请求

### 模型切换

- 新增 `/model` 命令，用于读取当前 bot 的可用模型列表
- 模型列表会自动附带编号
- 新增 `/model <编号>`，可将 bot 默认模型永久切换到对应模型

### Discord 回复体验

- 工具调用过程尽量聚合到同一条 Discord 消息里持续 `edit`
- 减少工具审批、工具结果、最终回复分散成多条消息的情况

### 会话删除链路

- panel 支持删除单个会话话题
- 删除 Discord thread-backed 会话时，会先删除 Discord 子区，再删除数据库中的 session
- 如果 thread 已被手动删除，则允许继续删除数据库中的 session
- 如果 thread 删除因权限或接口失败，则 session 删除失败

### 浏览器与人工接管

- 持久浏览器实现从 Chromium/CDP 路径迁移到 Camoufox
- 新增 `/browser` 命令，直接拉起 headed 手动浏览器
- 支持 noVNC 人工接管浏览器
- 修复 `manual_login` / noVNC 在 headless 与 headed 切换时的 display stack 竞态问题

### 代码结构调整

- 将 `/model` 命令逻辑从 `discord-adapter.ts` 中拆出，独立到单独模块，减少适配层堆叠

## 相关文件

- `packages/core/src/bot/discord-adapter.ts`
- `packages/core/src/bot/model-command.ts`
- `packages/core/src/bot/bot-manager.ts`
- `packages/core/src/llm/list-models.ts`
- `packages/core/src/mcp/persistent-browser-mcp.ts`
- `packages/panel/pages/chat.vue`
- `packages/panel/server/api/chat/topics/[id].delete.ts`
- `scripts/launch-browser-stack.sh`
- `scripts/resolve-camoufox-options.py`

## 说明

- 原项目通用文档请看 upstream README
- 这个 README 只维护当前 fork 的增量改动
