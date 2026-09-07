# OpenGUI-Plus

OpenGUI-Plus 是 [Core-Mate/OpenGUI](https://github.com/Core-Mate/OpenGUI) 的 DeepSeek Harness 扩展版，把「无线调试 / 指令库 / 动作模板 / 定时任务 / 项目管理 / 演示录制 / 工作流市场 / 反馈强化学习 / 设备池 / 执行回放」十大能力统一到一套零依赖的控制台里。

## 两种前端

控制台同时提供两套界面，**共用同一套 `/api/*` 后端**：

| 界面 | 文件 | 访问路径 | 面向对象 | 风格 |
| --- | --- | --- | --- | --- |
| 开发者控制台 | `web/index.html` | `/` 或 `/index.html` | 开发者 | 常用卡片 + 注册表驱动的方法浏览器，可看原始 JSON |
| 普通用户工作台 | `web/app.html` | `/app.html` | 普通用户 | 左侧设备投屏网格 + 右侧 10 个竖排模块 Tab，全中文标签化表单，隐藏技术方法名 |

工作台（`app.html`）是这一版的重点：用户不需要懂 `wlan-connection.saveDevice` 这类方法名，只要在「设备 / 指令 / 模板 / 定时 / 项目 / 演示 / 市场 / 反馈 / 设备池 / 回放」十个 Tab 中点选配置即可。开发者控制台保留不动，工作台的右上角有「开发者控制台 ↗」链接可随时跳转。

## 运行

```bash
npm install
npm run build        # tsc -p tsconfig.json，产出 lib/
npm start            # 启动控制台，默认 8787 端口
# 或
node lib/cli.js serve --port 8900 --data-dir /path/to/data
```

`--data-dir`（或环境变量 `OPENGUI_PLUS_DATA_DIR`）覆盖数据目录（设备画像、截图、录制回放等）。没有检测到 `adb` 时控制台自动降级为「纯控制台模式」，设备相关调用会返回明确错误而不是崩溃。

## 设备管理增强

`wlan-connection` 模块的设备画像（`DeviceProfile`）在原有的 `name / transport / host / port` 之外，新增了三个面向团队管理的字段，并贯穿保存与归一化链路：

- `groups`：设备分组（如 `qa, pixel, 主力`），工作台「已管理设备」页可逗号分隔批量编辑。
- `taskId`：绑定任务标识，把设备与某个任务/项目关联。
- `notes`：自由备注。

新增 `screencap` 方法：通过 adb 的 `exec-out screencap -p` 二进制通道（新增 `AdbRunner.execOut`）截取设备屏幕 PNG，写入 `<dataDir>/screenshots/`，供工作台设备网格实时轮询投屏；无 `execOut` 时自动回退到 `shell screencap -p` + `pull` 方案。

## 设备发现与实时刷新

工作台的设备网格不是「刷新一次才出现」，而是**实时**的：

- `wlan-connection.discover` 现在**并行**探测两类来源：
  1. `adb devices -l`（已连接的 USB / 已配对 WiFi 设备）；
  2. `adb mdns services`（手机在「开发者选项 → 无线调试」里开着的待配对设备，配对前不出现在 `devices -l` 里）。
  这些待配对设备以 `pairable`（含 `host / port / kind / known`）一并返回，工作台据此在网格里直接给出「用配对码配对 / 一键连接」按钮。
- 前端每 4 秒轮询一次 `discover`，**插上 USB 或新开无线调试的手机无需手动刷新就会出现在设备网格**；若电脑没装 Bonjour（Windows）或 adb mDNS 被防火墙拦截，`mdnsError` 会被捕获并在网格下方给出提示，此时可改用「设备」面板的「手动 WiFi」或「扫二维码」方式。
- 「设备」面板里的**连接状态**子页打开即自动展示：当前连接模式、连接状态、已连 adb 设备列表，以及通过无线调试广播出来的待配对设备；该页同样每 4 秒自动刷新，不再只显示按钮点击后的原始 JSON。

## 零依赖 HTTP API

控制台不依赖任何 Web 框架，所有能力都通过这些端点暴露，前端只是它们的可视化外壳：

- `GET /api/status` — 整体状态与已加载模块数
- `GET /api/modules` — 模块与方法清单（含入参提示）
- `POST /api/call` — 调用任意模块方法，body 为 `{ target: "模块.方法", input: {...} }`
- `GET /api/events/recent` — 最近事件
- `GET /api/events`（SSE）— 实时事件流
- `GET /files/<path>` — 读取模块产出的静态资源（截图、回放帧、导出文件）

`/api/call` 的响应是双层 Result 信封：`{ ok, value }`，其中 `value` 可能本身是另一个 `{ ok, value }`（模块自身返回了 Result）。前端 `call()` 会严格解包两层，避免把执行报告误判为数据。

## 测试

```bash
npm run check   # tsc --noEmit && vitest run && tsc -p && 控制台冒烟
```

`scripts/console-smoke.mjs` 会启动真实宿主（用 fake adb），驱动 `index.html` 与 `app.html` 里写死的全部方法名，确保服务端改名时浏览器侧不会静默 400；并校验 `/app.html` 可加载。
