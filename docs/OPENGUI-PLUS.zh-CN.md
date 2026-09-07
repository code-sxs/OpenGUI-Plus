# OpenGUI-Plus 增强版使用文档

> 本文档只讲 **OpenGUI-Plus 增强层**（10 个解耦模块）。上游 OpenGUI / DeepSeek Harness 的用法请看仓库根目录的 `README.zh-CN.md` 与 `docs/get-started.zh-CN.md`。

---

## 1. 这是什么

**OpenGUI-Plus** 是 [`Core-Mate/OpenGUI`](https://github.com/Core-Mate/OpenGUI) 的一个增强 Fork。它在**不改动上游核心代码**的前提下，以「解耦的 DSH 插件」形式叠加了 10 个面向真机自动化运维的模块：

| # | 模块 | 解决什么 |
|---|------|---------|
| 1 | 无线调试连接 `wlan-connection` | USB / WiFi / 自动三模式连接，记住设备，实时状态；Android 11+ 六位配对码配对与二维码配对（mDNS 自动解析配对端口） |
| 2 | 快捷指令库 `snippet-library` | 别名 + 标签 + 自动补全，JSON 导入导出 |
| 3 | 动作模板录制 `action-template` | 录制多步操作，参数化变量，一键执行 |
| 4 | 定时任务 `scheduler` | 单次 / 每天 / 每周 / Cron，执行指令·模板·流程 |
| 5 | 动作组与项目组 `project-group` | 一键切换整套配置（设备池、模板、指令） |
| 6 | AI 任务演示与教学录制 `demo-recorder` | 操作录制→模板、修正示范、版本修订 |
| 7 | 工作流模板市场 `workflow-marketplace` | `.opengui-workflow` 格式、市场、评分、一键运行 |
| 8 | 人类反馈强化学习回路 `feedback-rl` | 评价→经验库→检索，越用越聪明 |
| 9 | 多机协同与设备池 `device-pool` | 队列、优先级、负载均衡、并发上限 |
| 10 | 任务执行可视化回放 `replay` | 逐帧 HTML 回放：动作 / AI 决策 / 异常恢复 |

### 设计原则（为什么能零改动叠加）

- **核心零依赖**：所有模块只用 Node.js 标准库 + TypeScript，编译产物不依赖任何第三方运行时。
- **DSH 可选适配**：通过 `src/dsh/adapter.ts` 在运行时**动态探测** `@deepseek-ai/dsh-tools`；探测不到就降级为独立控制台，不阻塞任何功能。
- **本地持久化**：所有配置、模板、记录都存为 JSON 文件，位于数据目录（`~/.opengui-plus` 或 `--data-dir` / `OPENGUI_PLUS_DATA_DIR`），跨会话保留。
- **作用域隔离**：数据按「项目（project）」作用域隔离，切换项目组即切换一整套数据。

---

## 2. 架构一览

```
deepseek-harness-plugin/opengui-plus/
├── .codex-plugin/plugin.json     # 插件清单（OpenGUI-Plus）
├── src/
│   ├── core/                     # 零依赖基础层
│   │   ├── types.ts              # Result<T> / ok / fail / Page
│   │   ├── id.ts                 # createId / slugify / isAliasSafe
│   │   ├── events.ts            # EventBus + PLUS_EVENTS
│   │   ├── store.ts             # ScopedStore / PlusStore（原子写）
│   │   ├── module.ts            # ModuleContext / PlusModule / defineModule
│   │   ├── logger.ts            # Logger
│   │   ├── registry.ts          # ModuleRegistry（依赖排序启动、call 分发）
│   │   └── adb-runner.ts        # AdbRunner（真机 / 测试双实现）
│   ├── modules/                 # 10 个业务模块（各自一个目录）
│   ├── runtime/                 # cli.ts（命令行）、server.ts（HTTP+SSE 控制台）
│   ├── dsh/adapter.ts           # 动态探测 DSH，缺失时降级
│   ├── host.ts                  # PlusHost：注册表 + 项目切换 + 复制/导出/导入
│   └── index.ts                 # 插件入口（apply / createPlus / defaultModules）
├── web/index.html               # 单页控制台（10 个模块的视图与操作）
├── lib/                         # tsc 编译产物（npm run build 生成）
└── docs/                        # 本文档
```

模块之间**不直接互相 import 业务代码**，只通过 `ModuleContext.call(target, input)` 与事件总线解耦通信。

---

## 3. 快速开始

### 环境要求

- Node.js **≥ 22.5.0**
- 已安装 `adb`（可选，用于真机功能；无 adb 时模块自动降级为测试/演示模式）

### 安装与构建

```bash
cd deepseek-harness-plugin/opengui-plus
npm install            # 或 pnpm install
npm run build          # tsc 编译到 lib/
```

### 启动控制台

```bash
# 启动 HTTP + SSE 控制台（默认端口 8787，数据目录 ~/.opengui-plus）
node lib/cli.js serve --port 8787

# 浏览器打开控制台页面
#   - 若已构建 web：直接用浏览器打开 deepseek-harness-plugin/opengui-plus/web/index.html
#   - 控制台也提供静态服务与该页面
```

### 命令行速查

```bash
opengui-plus serve [--port 8787] [--host 127.0.0.1] [--data-dir <dir>]
opengui-plus status
opengui-plus modules
opengui-plus call <module.method> [--json '{...}'] [--key value ...]
opengui-plus connect --mode usb|wifi|auto [--host <ip>] [--port 5555]
opengui-plus run <templateId> [--package com.example.app ...]
opengui-plus help
```

---

## 4. 模块详解

### 模块一 · 无线调试连接 `wlan-connection`

**定位**：把 Android 设备的 USB / WiFi / 自动三种连接方式统一管理，记住常用设备，实时反映连接状态，并完整支持 Android 11+ 的两种无线配对入口。

**两种无线配对**

| 配对方向 | 手机上的入口 / 动作 | 方法 | 需要什么 |
|---|---|---|---|
| 手机显示二维码，电脑读取 | 使用二维码配对设备 | `pairWithQr` | 二维码文本（`qrText`）或图片路径（`image`，需本机装有 `zbarimg`） |
| 电脑显示二维码，手机读取（反向流） | 手机打开无线调试的二维码扫描入口 | `generatePairingQr` + `startQrPairing` | 电脑屏幕、手机与电脑同一局域网；方法会等待 mDNS 配对服务 |
| 手机显示配对码，电脑输入 | 使用配对码配对设备 | `pairWithCode` | `host` + 配对端口 + 6 位配对码 |

配对端口与连接端口是两个不同的端口：配对端口每次打开配对页面都会变，连接端口通常是 5555。二维码中携带服务名和 6 位配对码；`pairWithQr` / `startQrPairing` 会通过 `adb mdns services` 自动解析出 `host:port`；解析不到时错误信息会写明原因，不会假装成功。`pairAndConnect` 把配对、连接、记档合成一步。

**关键方法**

| 方法 | 作用 |
|------|------|
| `status` | 刷新并返回当前连接状态 |
| `setMode` | 设置连接模式（usb / wifi / auto） |
| `discover` | 探测 adb 当前可见的设备 |
| `listDevices` | 列出已保存的设备 |
| `saveDevice` | 保存设备（名称 / 传输方式 / host / port / 可选 pairingPort） |
| `removeDevice` | 删除已保存设备 |
| `connect` | 按当前或指定模式连接 |
| `disconnect` | 断开当前连接 |
| `pair` | 统一配对入口，自动识别配对码、手机二维码或反向二维码流 |
| `generatePairingQr` | 电脑生成二维码，返回文本、ASCII、PNG Base64 和 Data URL |
| `startQrPairing` | 显示/返回电脑二维码，轮询 mDNS，手机扫描后自动 `adb pair`，可继续连接 |
| `pairWithCode` | 六位配对码配对 |
| `pairWithQr` | 手机显示二维码时，读取二维码并自动 mDNS 解析配对端口 |
| `pairAndConnect` | 配对后直接连接并记档（推荐） |
| `mdnsServices` | 列出 mDNS 服务，区分配对端口与连接端口 |
| `parsePairingQr` | 只解析二维码，不连设备 |
| `decodePairingQr` | 用外部解码器识别二维码图片 |
| `pairingGuide` | 配对操作指引与排障清单 |
| `enableTcpip` | 将 USB 设备切换到 TCP/IP 模式 |
| `autoConnect` | 启动时自动连接（内部调用） |

**示例**

```bash
# 保存一台 WiFi 设备
opengui-plus call wlan-connection.saveDevice --transport wifi --host 192.168.1.23 --port 5555 --name 小米9
# 自动连接
opengui-plus connect --mode auto
# 查看状态
opengui-plus call wlan-connection.status

# 六位配对码配对并连接
opengui-plus call wlan-connection.pairAndConnect --json '{"host":"192.168.1.23","port":39443,"code":"123456","name":"小米14"}'
# 手机显示二维码，电脑读取并配对连接
opengui-plus call wlan-connection.pairAndConnect --json '{"qrText":"WIFI:T:ADB;S:studio-abc123._adb-tls-pairing._tcp;P:123456;;","name":"小米14"}'
# 电脑生成二维码；把返回的 dataUrl / pngBase64 显示到屏幕
opengui-plus call wlan-connection.generatePairingQr --json '{"serviceName":"studio-opengui","code":"123456"}'
# 手机扫描电脑二维码后，轮询 mDNS，自动配对并连接；可用 timeoutMs 调整等待时间
opengui-plus call wlan-connection.startQrPairing --json '{"serviceName":"studio-opengui","code":"123456","timeoutMs":60000,"name":"小米14"}'
# 看 mDNS 上有哪些配对 / 连接服务
opengui-plus call wlan-connection.mdnsServices
```

**数据存储**：`devices.json`（已保存设备）、`state.json`（当前模式与连接）。

---

### 模块二 · 快捷指令库 `snippet-library`

**定位**：用短别名替代长指令，支持标签分类、前缀自动补全，可整库导入导出。

**关键方法**：`list` · `save` · `remove` · `resolve` · `complete` · `listTags` · `exportJson` · `importJson`

**示例**

```bash
opengui-plus call snippet-library.save --alias sc --command "截屏并拉取" --tags '["调试"]'
opengui-plus call snippet-library.complete --prefix sc     # 自动补全别名
opengui-plus call snippet-library.resolve --alias sc       # 展开并返回完整指令，累加使用次数
opengui-plus call snippet-library.exportJson               # 导出整库 JSON
```

首次启动会写入 7 条内置默认指令（`act`/`back`/`home`/`kill`/`launch`/`pkg`/`sc`）。

---

### 模块三 · 动作模板录制 `action-template`

**定位**：把一串操作录制成可复用的模板，自动提取 `{{变量}}`，支持参数化执行。

**关键方法**：`startRecording` · `recordStep` · `stopRecording`（自动提取变量）· `list` · `get` · `remove` · `update` · `execute` · `save-from-demo`

**示例**

```bash
opengui-plus call action-template.startRecording --name "打开设置"
opengui-plus call action-template.recordStep --action "点击设置图标"
opengui-plus call action-template.stopRecording
opengui-plus call action-template.list
# 执行（带变量）
opengui-plus run <templateId> --package com.android.settings
```

录制的步骤若含 `{{appPackage}}` 之类占位符，执行时由传入变量替换。

---

### 模块四 · 定时任务 `scheduler`

**定位**：按单次 / 每天 / 每周 / Cron 调度执行指令、模板或流程，自带执行日志。

**关键方法**：`create` · `list` · `update` · `remove` · `enable` · `disable` · `runNow` · `tick`（内部每 30 秒）· `nextRuns` · `runs`

**示例**

```bash
# 每天 09:30 执行某指令
opengui-plus call scheduler.create --name "早安巡检" --cron "30 9 * * *" --action '{"module":"snippet-library","method":"resolve","input":{"alias":"health"}}'
# 立即跑一次
opengui-plus call scheduler.runNow --id <taskId>
# 看执行日志
opengui-plus call scheduler.runs
```

---

### 模块五 · 动作组与项目组 `project-group`

**定位**：把「设备、模板、指令、调度」打包成一个项目组，一键切换整套配置。

**关键方法**：`create` · `list` · `current` · `switch`（发布事件，宿主重置各模块数据）· `update` · `remove` · `duplicate` · `export` · `import`

**示例**

```bash
opengui-plus call project-group.create --name 抖音项目 --copyFrom default
opengui-plus call project-group.switch --id <groupId>   # 切换后所有模块数据作用域跟着变
opengui-plus call project-group.export --id <groupId>   # 导出数据包
```

---

### 模块六 · AI 任务演示与教学录制 `demo-recorder`

**定位**：录制一段「标准操作示范」，可标记为教学样本，支持**修正示范**（全量替换步骤并升级修订号），并一键转为动作模板。

**关键方法**：`startDemo` · `captureStep` · `stopDemo` · `listDemos` · `getDemo` · `removeDemo` · `revise` · `toTemplate`

**示例**

```bash
opengui-plus call demo-recorder.startDemo --name "正确登录姿势"
opengui-plus call demo-recorder.captureStep --action "输入账号" --decision "先聚焦输入框"
opengui-plus call demo-recorder.stopDemo
# 录得不对？修正示范（修订号 +1）
opengui-plus call demo-recorder.revise --id <demoId> --steps '[{"action":"输入账号"}]'
# 转成动作模板
opengui-plus call demo-recorder.toTemplate --id <demoId>
```

---

### 模块七 · 工作流模板市场 `workflow-marketplace`

**定位**：以 `.opengui-workflow` 为交换格式的市场，可浏览、安装、评分、发布、一键运行。

**关键方法**：`categories` · `browse` · `detail` · `install` · `uninstall` · `listInstalled` · `publish` · `rate` · `exportWorkflow` · `importWorkflow` · `run`

**示例**

```bash
opengui-plus call workflow-marketplace.browse --category 社交
opengui-plus call workflow-marketplace.install --id <wfId>
opengui-plus call workflow-marketplace.rate --id <wfId> --score 5 --comment "好用"
opengui-plus call workflow-marketplace.run --id <wfId>
# 导出为文件分享
opengui-plus call workflow-marketplace.exportWorkflow --id <wfId>
```

---

### 模块八 · 人类反馈强化学习回路 `feedback-rl`

**定位**：把人工「对 / 错 / 原因」判定沉淀为经验库，后续按现象检索相关经验，形成越用越聪明的闭环。

**关键方法**：`record` · `listRecords` · `listExperiences`（按命中降序）· `queryRelevant` · `markApplied` · `summary` · `successRate`

**示例**

```bash
opengui-plus call feedback-rl.record --task "登录" --verdict good --reason "先聚焦输入框再输入"
opengui-plus call feedback-rl.record --task "登录" --verdict bad --reason "直接点登录会漏填验证码"
# 下次遇到类似现象时检索
opengui-plus call feedback-rl.queryRelevant --symptom "登录失败"
opengui-plus call feedback-rl.successRate --task "登录"
```

---

### 模块九 · 多机协同与设备池 `device-pool`

**定位**：把多台设备编入设备池，用队列 + 优先级 + 并发上限做负载均衡，适合批量任务。

**关键方法**：`register` · `unregister` · `list` · `listGroups` · `tag` · `setConcurrency` · `refresh` · `enqueue` · `dequeue` · `assign` · `complete` · `status` · `autoAssign`

**示例**

```bash
opengui-plus call device-pool.register --name 设备A --serial emulator-5554
opengui-plus call device-pool.setConcurrency --serial emulator-5554 --limit 2
opengui-plus call device-pool.enqueue --task '{"kind":"run-template","id":"<tid>"}'
opengui-plus call device-pool.autoAssign     # 尽量把队列任务分配出去
opengui-plus call device-pool.status
```

---

### 模块十 · 任务执行可视化回放 `replay`

**定位**：逐帧记录「动作 / AI 决策理由 / 异常与恢复」，导出**单文件 HTML** 回放，可分享、可逐帧追溯。

**关键方法**：`startRecording` · `markFrame` · `stopRecording` · `listReplays` · `getReplay` · `removeReplay` · `annotate` · `exportReplay`（HTML / JSON）· `stats`

**示例**

```bash
opengui-plus call replay.startRecording --name "登录流程" --taskLabel task-42
opengui-plus call replay.markFrame --sessionId <sid> --action "点击登录" --decision "首页只有登录入口" --ok true
opengui-plus call replay.markFrame --sessionId <sid> --action "输入账号" --ok false --anomaly '{"symptom":"输入框被遮挡","recovery":"等待动画结束"}'
opengui-plus call replay.stopRecording --sessionId <sid>
# 导出单文件 HTML（可分享）
opengui-plus call replay.exportReplay --id <sid> --format html
```

导出的 HTML 自带时间轴、逐帧查看、键盘左右键切换，且不依赖任何外部资源。

---

## 5. 与上游的关系

- 远程 `upstream` 指向 `https://github.com/Core-Mate/OpenGUI.git`，增强内容全部位于 `deepseek-harness-plugin/opengui-plus/`，**不改动上游其它目录**。
- 同步上游：`git fetch upstream && git merge upstream/main`（如有冲突，通常只在 README 等文档）。

## 6. 数据存储位置

默认数据目录：

- Linux / macOS：`~/.opengui-plus/`
- Windows：`C:\Users\<你>\.opengui-plus\`

可用 `--data-dir <dir>` 或环境变量 `OPENGUI_PLUS_DATA_DIR` 覆盖。目录内按 `projects/<projectId>/` 作用域存放各模块的 JSON 文件。

## 7. 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # 产出 lib/
npm run smoke       # 冒烟：真实起控制台，跑通十个模块
npm run check       # 以上全部串起来
```

新增模块只需在 `src/modules/<your-module>/index.ts` 用 `defineModule({...})` 导出，并在 `src/index.ts` 的 `defaultModules` 里追加即可，无需改动任何其它模块。

## 8. 控制台前端

`web/index.html` 是零依赖单页控制台（`npm start` 后访问打印出来的地址）。它分两层：

1. **常用卡片**：手工编排的高频操作，覆盖十个模块，字段带中文提示。
2. **方法浏览器**：下拉框由 `/api/modules` 的 `methodSpecs` 动态生成，**全部 100+ 个方法都可达**；服务端新增方法后前端无需改动即可调用。

几个实现约定：

- 注册表的每次调用都会包一层 `{ ok: true, value }`，模块自身也可能返回 `Result`，因此前端要做**两次解包**。判定内层信封时必须严格：`ok === true` 要有 `value` 键、`ok === false` 要有字符串 `error`，否则会把执行报告（`{ ok: true, results: [...] }`）误当成信封。
- 前端启动时用 `/api/modules` 反向校验所有写死的方法名，不匹配会在概览页给出警告——避免服务端改名后前端只表现为一个无声的 400。
- 返回里的二维码（`dataUrl` / `pngBase64`）、截图（`/files/<path>`）、HTML 回放会分别渲染成图片、缩略图和下载链接。

## 9. 验收缺陷修复记录（F-01 … F-05）

DeepSeek Harness 首轮验收跑了 67 项测试，暴露 5 个缺陷，均已修复并加了回归测试（`src/core/regressions.test.ts`）：

| 编号 | 症状 | 根因 | 修复 |
| --- | --- | --- | --- |
| F-01 | 定时任务指向不存在的目标也创建成功 | `context.call` 返回外层恒为 `ok: true` 的双层包装 | 新增 `src/core/call.ts` 的 `callModule()` 统一解包；`create`/`update` 增加 `verifyTarget()`（可用 `skipTargetCheck: true` 跳过） |
| F-02 | Windows 上切换项目组偶发 EPERM | 两方同时 rename 同一个 `current-project.json` | 原子写加 rename 重试退避 + 唯一临时名 + 直接写兜底；切换改为 awaited 的 `__host__.switchProject` 单一写者 |
| F-03 | 演示录制转模板"成功"但模板库里没有 | 传了 `{ template }` 而 `save-from-demo` 要 `{ name, steps }`，且只查外层 `ok` | 改为传字段 + `callModule` 解包，返回 `templateId` |
| F-04 | dsh-tools 下注册 0 个工具 | spec 缺必填的 `output.render`，`parameters` 用了 JSON Schema 方言 | `src/dsh/adapter.ts` 改为**方言探测**（modern / legacy 两套 spec），并修正 `dshToolName` 的驼峰切分 |
| F-05 | 模板执行时 `{{变量}}` 原样下发到 adb | 各分支读的是替换前的 `step.params` | 全部改为读 `resolveParams()` 的结果 |

### 修复过程中额外发现并修掉的两个问题

- **`project-group.current` 切换后恒为 `null`**：`switch` 会触发宿主的 `reseatAll`，模块被重新加载时读到的还是旧文件，随后 `persistCurrent()` 又把旧值写回去——而这个键（`current-project`）正是宿主刚写过的同一个文件，等于把宿主指针擦掉。现在 `load()` 会把宿主的 `ctx.projectId` 作为兜底，`switch` 完成后也会重新断言指针。
- **`store.update` 自锁死**：`update` 若内部再调 `set()`，会在同一个 key 上二次入队并等待外层任务，永不 settle。已改为内联写路径。

### 验证结果

```
tsc --noEmit        0 error
vitest run          4 文件 / 69 测试通过
tsc                 构建产出 lib/ 成功
npm run smoke       29 项全通过（真实 HTTP + 十大模块）
```
