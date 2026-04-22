# ZakoBot

ZakoBot 是一个基于 TypeScript 的模块化 Bot 框架，当前提供：

- `zakobot` CLI
- Discord Bot 运行时
- 基于 OpenAI 兼容接口的模型调用
- SQLite 数据库
- Web 管理面板

如果你是第一次使用，按下面的“快速开始”走就可以。

## 快速开始

### 1. 安装

任选一种方式：

```bash
npm install -g zakobot
```

或直接临时运行：

```bash
npx zakobot init
npx zakobot start
```

如果你使用 pnpm：

```bash
pnpm dlx zakobot init
pnpm dlx zakobot start
```

### 2. 初始化工作目录

```bash
zakobot init
```

默认会创建：

```text
~/.zakobot
```

当前版本运行时默认会把数据库放在：

```text
~/.zakobot/data.db
```

### 3. 启动

```bash
zakobot start
```

启动后打开：

- Panel: [http://127.0.0.1:6324](http://127.0.0.1:6324)
- Core API: [http://127.0.0.1:6325](http://127.0.0.1:6325)

首次打开面板时需要登录，默认密码是：

```text
123456
```

登录后如果仍在使用默认密码，面板会提醒你尽快修改。

## 命令说明

```bash
zakobot init
zakobot start
zakobot core
zakobot panel
```

- `zakobot init`：初始化工作目录
- `zakobot start`：同时启动 `core` 和 `panel`
- `zakobot core`：只启动 Bot 核心进程
- `zakobot panel`：只启动管理面板

## 运行要求

- 建议使用当前 LTS 版本的 Node.js
- 可以访问你要使用的模型服务
- 如果使用 Discord，需要准备 Bot Token

### 可选：按需浏览器 MCP 前置环境

如果你要使用源码里的 `packages/core/src/mcp/persistent-browser-mcp.ts` 为多个 Bot 提供按需浏览器能力，还需要准备下面这些系统组件：

- `chromium`
- `Xvfb`
- `fluxbox`
- `x11vnc`
- `websockify`
- `noVNC` 静态资源目录，默认脚本使用 `/usr/share/novnc/`

这个 MCP 不是默认 CLI 的一部分，它面向源码部署场景，默认启动脚本是：

```text
scripts/launch-browser-stack.sh
```

默认配置文件路径是：

```text
/etc/zako-browser/mcp-profiles.json
```

每个浏览器实例还需要一个对应的环境文件：

```text
/etc/zako-browser/<instance>.env
```

环境文件至少需要提供这些变量：

```bash
DISPLAY_NUMBER=91
PROFILE_DIR=/path/to/profile
RUNTIME_DIR=/path/to/runtime
VNC_PORT=5901
VNC_PASSWORD_FILE=/path/to/vncpass
NOVNC_BIND=0.0.0.0
NOVNC_PORT=6101
REMOTE_DEBUGGING_PORT=9221
START_URL=about:blank
```

`mcp-profiles.json` 里的每个 profile 需要能对上一个实例名，并提供：

- `id`
- `label`
- `instanceName`
- `cdpUrl`
- `noVncUrl`
- `vncPassword`

可选字段包括：

- `launchCommand`
- `launchArgs`
- `startTimeoutMs`
- `idleTimeoutMs`
- `manualLoginMessage`

这套实现依赖 Chromium 的远程调试端口和持久化 profile 目录：浏览器进程可以按需启动和停止，但登录态保存在 `PROFILE_DIR` 下，方便 Bot 在手动登录后继续复用同一个浏览器环境。

## 首次使用建议

启动后，建议按这个顺序配置：

1. 打开管理面板
2. 先在模型设置里配置你的模型平台
3. 再创建角色、Bot 实例或测试聊天功能
4. 确认 Core 状态和插件状态正常

当前项目的重点是先把核心运行链路跑通，所以界面和功能仍在持续完善中。

## 配置

当前版本主要通过环境变量控制运行参数。

### 常用环境变量

```bash
ZAKOBOT_HOME=~/.zakobot
CORE_API_PORT=6325
PANEL_PORT=6324
DATABASE_URL=/path/to/zakobot.db
CORE_API_URL=http://127.0.0.1:6325
```

说明：

- `ZAKOBOT_HOME`：工作目录
- `CORE_API_PORT`：Core API 端口
- `PANEL_PORT`：Panel 端口
- `DATABASE_URL`：SQLite 数据库文件路径
- `CORE_API_URL`：Panel 调用 Core 时使用的地址

### Windows PowerShell 示例

```powershell
$env:CORE_API_PORT="7001"
$env:PANEL_PORT="7000"
zakobot start
```

### macOS / Linux 示例

```bash
CORE_API_PORT=7001 PANEL_PORT=7000 zakobot start
```

## 数据位置

默认情况下，ZakoBot 会在用户目录下保存自己的运行数据。

```text
~/.zakobot/
  data.db
  .env
```

其中：

- `data.db` 是 SQLite 数据库
- `.env` 会在 `zakobot init` 时创建，当前更适合作为配置模板参考

## 项目结构

如果你只是使用发布包，这一节可以先跳过。

```text
packages/core      Bot 运行时、插件、内部 API
packages/panel     Web 管理面板
packages/database  SQLite + Drizzle 数据层
packages/cli       zakobot 命令行入口
shared             跨包共享类型
```

## 本地开发

如果你要参与开发仓库源码：

### 安装依赖

```bash
pnpm install
```

### 启动开发环境

```bash
pnpm dev
```

这会并行启动：

- `shared` watch build
- `database` watch build
- `core`
- `panel`

### 本地运行正式版

如果不全局安装 `zakobot`，也可以在仓库目录中直接构建并运行正式产物：

```bash
pnpm start
```

该命令会先执行完整构建，再通过本地 CLI 启动 `core` 和 `panel`。

### 常用命令

```bash
pnpm dev:deps
pnpm dev:core
pnpm dev:panel
pnpm start
pnpm build
pnpm lint
```

### 数据库命令

```bash
pnpm --filter @zakobot/database db:generate
pnpm --filter @zakobot/database db:migrate
pnpm --filter @zakobot/database db:studio
```

## 当前实现说明

目前仓库中的已知实现包括：

- `core` 与 `panel` 是两个独立进程
- 两者共享同一个 SQLite 数据库文件
- `panel` 通过 `CORE_API_URL` 调用 `core`
- 当前明确支持的平台是 Discord
- 模型调用按 OpenAI 兼容接口接入

## 排查思路

### 启动后面板打不开

先确认 `zakobot start` 没有报错，再检查端口是否被占用：

- `6324` 用于 Panel
- `6325` 用于 Core API

如果端口冲突，改用环境变量指定新端口后重新启动。

### Panel 能打开，但拿不到 Core 状态

通常是 `core` 没有成功启动，或者 `CORE_API_URL` 配置不对。

### 数据库位置不符合预期

显式设置 `DATABASE_URL` 即可。

## License

MIT
