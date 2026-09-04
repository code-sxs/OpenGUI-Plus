# 15. 给 DeepSeek Harness 的完整功能验证提示词

这篇不是普通教程，而是一段可以**整段复制给 DeepSeek Harness** 的验收提示词。它要求 Harness 先检查环境，再验证源码、独立 CLI、持久化、十个模块、组合工作流和可选真机链路，最后产出证据充分的报告。

## 先说结论：不需要卸载已经安装的 OpenGUI

推荐按下面的安全优先级测试：

| 场景 | 是否卸载现有 OpenGUI | 推荐方式 |
|---|---:|---|
| 已有 OpenGUI 已安装，先验证增强层逻辑 | **不需要** | 直接在 OpenGUI-Plus 源码目录执行独立 CLI / 测试；使用独立 `--data-dir` |
| 验证 OpenGUI-Plus 是否能被 DSH 发现和注册 | **不需要** | 在保留原插件的前提下，使用 DSH 支持的本地插件加载方式或隔离 profile |
| 验证真实手机连接和截图 | **不需要** | 复用已授权设备，但先只做 discover / status / 低风险动作 |
| 想把 OpenGUI-Plus 设为默认生产插件 | 不建议直接替换 | 先完成报告，再由用户决定是否切换或单独配置 profile |

OpenGUI-Plus 的核心层和 DSH 适配层是解耦的。即便 DSH 当前只加载了原版 OpenGUI，也可以先通过 `node lib/cli.js` 验证增强版的绝大多数功能；这不是“假测试”，而是验证同一套 `PlusHost`、`ModuleRegistry` 和十个模块。

---

## 一、整段复制给 DeepSeek Harness 的提示词

```text
你现在是 OpenGUI-Plus 的验收测试工程师。请对 OpenGUI-Plus 做一次完整、可复现、证据充分的功能验证，并生成 Markdown 测试报告和 JSON 原始结果。

【项目目标】
OpenGUI-Plus 是 Core-Mate/OpenGUI 的增强层，位于 deepseek-harness-plugin/opengui-plus/。它以解耦 DSH 插件形式提供十个模块：
1. wlan-connection：无线调试连接
2. snippet-library：快捷指令库
3. action-template：动作模板录制与参数化执行
4. scheduler：单次 / 每天 / 每周 / Cron 定时任务
5. project-group：项目组与动作组
6. demo-recorder：AI 演示与教学录制
7. workflow-marketplace：.opengui-workflow 工作流模板市场
8. feedback-rl：人类反馈经验回路
9. device-pool：多机设备池、队列与负载均衡
10. replay：任务执行逐帧回放

【最重要的安全约束】
1. 不要卸载、覆盖、删除或破坏当前已经安装的 OpenGUI、DeepSeek Harness、DSH workspace、模型配置、凭据、手机授权或其他插件。
2. 不要执行 git reset --hard、删除用户目录、删除 DSH 数据目录、清空生产数据或广泛删除文件。
3. 不要发送消息、发布内容、购买、删除账号数据、修改真实业务数据，也不要在真实手机上执行不可逆动作。
4. 不要读取、打印或上传任何 token、密码、Cookie、私钥、完整凭据文件。报告中只写“已配置 / 未配置”，不要写秘密值。
5. 优先使用源码目录和独立临时数据目录进行验证。默认不要使用用户现有的 ~/.opengui-plus 数据目录，以免污染真实数据。
6. 真实设备测试必须分层：先 discover / status，再连接，再做只读或低风险动作。任何会发送、发布、删除、购买、改账号的动作都必须停下并向我请求确认。
7. 如果某条命令、某种 DSH 本地插件加载方式或某个依赖不可用，不要伪造通过；记录 BLOCKED，并给出准确原因和替代验证方式。
8. 在执行命令前先确认当前工作目录。不要猜路径；如果找不到仓库，先搜索工作区或询问我。

【测试目标与报告要求】
请验证以下层级，并在报告中分别给出 PASS / FAIL / BLOCKED：
A. 源码和依赖完整性
B. TypeScript 类型检查、单元测试、构建
C. 独立 CLI 和模块注册
D. 独立临时数据目录下的十模块功能
E. 跨会话持久化和项目作用域隔离
F. 模块之间的组合工作流
G. DSH 动态适配和工具注册（如果当前 DSH 支持本地插件加载）
H. 真实 ADB / Android 设备链路（只有检测到设备并且动作安全时执行）

每个测试都必须记录：
- 测试 ID
- 测试目的
- 执行命令或调用目标
- 输入摘要（不要包含秘密）
- 实际结果摘要
- 预期结果
- PASS / FAIL / BLOCKED
- 证据路径（日志、JSON、HTML 回放、命令输出）
- 如果失败，给出复现步骤和建议修复

【第 0 阶段：定位仓库和建立隔离目录】
1. 查找 OpenGUI-Plus 仓库。优先检查：
   - 当前工作区下的 OpenGUI-Plus
   - C:\Users\AYU20\WorkBuddy AI\2026-09-04-09-09-42\OpenGUI-Plus
   - 也可以使用公开仓库 https://github.com/code-sxs/OpenGUI-Plus
2. 确认增强包目录：
   <repo>/deepseek-harness-plugin/opengui-plus
3. 确认这些文件存在：
   - package.json
   - package-lock.json
   - tsconfig.json
   - src/index.ts
   - src/host.ts
   - src/dsh/adapter.ts
   - src/modules/ 下的十个模块目录
   - web/index.html
4. 创建测试证据目录，必须在仓库外或被 .gitignore 忽略的位置，例如：
   - Windows：<repo>/.test-artifacts/opengui-plus/<timestamp>/
   - 或系统临时目录下的 opengui-plus-validation-<timestamp>
5. 为本次测试创建独立数据目录 TEST_DATA_DIR，不要使用现有生产数据目录：
   - Windows 示例：<repo>/.test-artifacts/opengui-plus/<timestamp>/data
6. 把以下信息写入报告开头：操作系统、Node 版本、npm 版本、ADB 是否存在、DSH 是否存在、仓库路径、commit、测试数据目录。

【第 1 阶段：源码、依赖和构建验证】
进入 <repo>/deepseek-harness-plugin/opengui-plus 后执行：

npm install
npm run typecheck
npm test
npm run build
npm run check
node lib/cli.js help
node lib/cli.js modules --data-dir TEST_DATA_DIR
node lib/cli.js status --data-dir TEST_DATA_DIR

要求：
- npm run typecheck 必须成功。
- npm test 必须报告所有测试通过；记录测试文件和通过数量。
- npm run build 必须生成 lib/cli.js、lib/index.js 和 lib/modules/。
- npm run check 必须成功。
- help、modules、status 都必须能运行。
- 如果 npm install 修改了 lockfile，不要提交修改；报告中记录是否发生变更。

【第 2 阶段：CLI 和注册表验证】
使用独立 TEST_DATA_DIR 执行：

node lib/cli.js modules --data-dir TEST_DATA_DIR

确认模块列表中至少有：
wlan-connection、snippet-library、action-template、scheduler、project-group、demo-recorder、workflow-marketplace、feedback-rl、device-pool、replay

逐个检查 modules 输出中的方法列表与源码 methodSpecs 是否一致。不要只检查模块名称；报告里列出每个模块的方法数量和方法名。

执行：
node lib/cli.js status --data-dir TEST_DATA_DIR
node lib/cli.js call project-group.current --data-dir TEST_DATA_DIR
node lib/cli.js call snippet-library.list --data-dir TEST_DATA_DIR
node lib/cli.js call action-template.list --data-dir TEST_DATA_DIR
node lib/cli.js call scheduler.list --data-dir TEST_DATA_DIR
node lib/cli.js call workflow-marketplace.categories --data-dir TEST_DATA_DIR
node lib/cli.js call feedback-rl.summary --data-dir TEST_DATA_DIR
node lib/cli.js call device-pool.status --data-dir TEST_DATA_DIR
node lib/cli.js call replay.listReplays --data-dir TEST_DATA_DIR

【第 3 阶段：模块一 wlan-connection 独立测试】
目标：验证配置校验、设备保存、模式持久化和无 ADB 时的明确降级；有 ADB 时再验证 discover。

在无设备也能做的测试：
1. 保存一条 USB 配置：
node lib/cli.js call wlan-connection.saveDevice --data-dir TEST_DATA_DIR --json '{"name":"test-usb","transport":"usb","serial":"TEST_SERIAL"}'
2. 保存一条 WiFi 配置：
node lib/cli.js call wlan-connection.saveDevice --data-dir TEST_DATA_DIR --json '{"name":"test-wifi","transport":"wifi","host":"192.0.2.10","port":5555}'
   192.0.2.10 是文档保留地址，不要真的连接它。
3. 列出并确认两条配置存在：
node lib/cli.js call wlan-connection.listDevices --data-dir TEST_DATA_DIR
4. 切换 auto 模式并查询：
node lib/cli.js call wlan-connection.setMode --data-dir TEST_DATA_DIR --json '{"mode":"auto","autoConnect":false}'
node lib/cli.js call wlan-connection.status --data-dir TEST_DATA_DIR
5. 使用错误输入测试失败边界：缺少 transport、WiFi 缺 host、非法 mode。失败必须是明确 Result 错误，并且不能破坏已有配置。
6. 删除测试设备并确认删除：
node lib/cli.js call wlan-connection.removeDevice --data-dir TEST_DATA_DIR --id <saved-id>

只有检测到真实 ADB 设备时才执行：
node lib/cli.js call wlan-connection.discover --data-dir TEST_DATA_DIR
node lib/cli.js call wlan-connection.status --data-dir TEST_DATA_DIR

不要自动执行 pair、enableTcpip 或 connect 到未知设备。若要测试，先展示设备 serial / host / 端口并请求我的确认。

【第 4 阶段：模块二 snippet-library 独立测试】
1. 首次 list，确认默认数据或空库行为符合实现。
2. 保存：
node lib/cli.js call snippet-library.save --data-dir TEST_DATA_DIR --json '{"alias":"test-health","command":"检查测试设备状态","tags":["test","readonly"],"description":"只读测试指令"}'
3. 查询、按标签过滤、按关键词过滤、列标签：
node lib/cli.js call snippet-library.list --data-dir TEST_DATA_DIR
node lib/cli.js call snippet-library.list --data-dir TEST_DATA_DIR --tag test
node lib/cli.js call snippet-library.listTags --data-dir TEST_DATA_DIR
4. 自动补全和解析：
node lib/cli.js call snippet-library.complete --data-dir TEST_DATA_DIR --prefix test-
node lib/cli.js call snippet-library.resolve --data-dir TEST_DATA_DIR --alias test-health
   确认 resolve 后 useCount 增加。
5. 按 id 更新 command / description，确认 alias 唯一性校验。
6. exportJson 导出；用一个新增 alias 做 merge import；再在另一个隔离数据目录做 replace import。
7. 用非法 alias、空 command、重复 alias 测试失败，确认原库未被破坏。
8. 删除测试 alias，确认 list 中不存在。

【第 5 阶段：模块三 action-template 独立测试】
1. 开始录制：
node lib/cli.js call action-template.startRecording --data-dir TEST_DATA_DIR --json '{"name":"test-template","description":"只读验证模板"}'
2. 追加至少五步，覆盖 connect、launch、wait、screenshot、snippet；参数中使用 {{package}} 和 {{reportPath}}。如果当前实现要求字段名为 recordingId，请严格使用返回的 recordingId。
3. stopRecording，确认自动提取变量。
4. get / list，确认 steps、variables、runCount。
5. execute 一次，变量传：
{"package":"com.example.test","reportPath":"TEST_REPORT_PATH"}
   没有真实设备时，接受 skipped / degraded，但不能伪称真实动作成功；确认执行报告结构正确。
6. 缺少变量、未知模板 id、非法 step type 必须明确失败。
7. update 后确认变量重新提取；remove 后确认不存在。
8. 如果 demo-recorder 已成功生成步骤，验证 save-from-demo 能创建动作模板。

【第 6 阶段：模块四 scheduler 独立测试】
不要创建真实生产任务。所有任务都使用 test 名称和测试目标。

1. 创建一个 disabled 的单次任务：
{"name":"test-once","schedule":{"kind":"once","at":"2099-01-01T00:00:00+08:00"},"target":{"type":"snippet","alias":"test-health"},"enabled":false}
2. 创建 daily、weekly、cron 的 disabled 任务；表达式用未来或不会触发生产动作的测试目标。
3. list、nextRuns、enable、disable、update、runs。
4. runNow 只对只读 test-health 目标执行；检查日志。
5. tick，确认不会误触发未来任务。
6. 删除全部 test 任务。
7. 测试非法 schedule、缺失 target、未知 snippet / template；失败不能修改旧任务。
8. 报告每种 schedule 是否创建成功、nextRunAt 是否合理、runs 是否记录。

【第 7 阶段：模块五 project-group 独立测试】
1. 创建 project-test-a 和 project-test-b，使用不同 tags。
2. current、list，确认当前项目。
3. 在 project-test-a 写入一个测试 snippet 或模板，切换到 project-test-b，确认看不到 A 的项目数据；再切回 A 确认数据回来。
4. duplicate A 为 project-test-copy，检查项目元数据和模块数据是否符合实现。
5. export A 到测试报告目录；import 为 project-test-import。
6. update 标签和说明。
7. 删除所有 test 项目组。删除当前项目之前先切换回默认项目。
8. 报告清楚区分项目作用域数据与全局设备 / 反馈数据，不要把“切换后仍能看到全局设备”判为泄漏。

【第 8 阶段：模块六 demo-recorder 独立测试】
1. startDemo 创建 test-demo。
2. captureStep 录制 launch、wait、tap、input，参数中使用 {{package}}、{{username}}；没有 ADB 时 captureScreen 可以降级，但步骤数据必须保存。
3. stopDemo，确认 ready。
4. listDemos、getDemo。
5. revise 用完整 steps 替换，确认 revision 增加，修订说明保留。
6. toTemplate，确认生成模板或返回明确的依赖提示。
7. 非法 recordingId、ready 状态继续 capture、空 steps revise 必须失败。
8. removeDemo 清理测试数据。

【第 9 阶段：模块七 workflow-marketplace 独立测试】
1. categories、browse、detail，记录内置模板数量和分类。
2. 选择一个不含外部真实账号和危险动作的内置模板做 detail；如果没有安全模板，只做 browse，不要 install / run。
3. 对安全测试模板执行 install、listInstalled、uninstall。
4. exportWorkflow，检查文件或 content 的格式版本、name、category、parameters、preconditions、steps。
5. 用一个完全本地、无危险 shell、无真实账号的最小 `.opengui-workflow` 做 importWorkflow。
6. import 后 detail；必要时 install；run 只允许在无设备降级模式或安全测试设备上执行。
7. rate 使用测试评分，记录是否是本地市场评分，不要宣称已经上传到公共互联网市场。
8. publish 只对本地测试模板执行；发布前检查没有 token、密码、IP、serial、截图绝对路径。

【第 10 阶段：模块八 feedback-rl 独立测试】
1. record 一条 success、一条 partial、一条 failure，全部使用 test-task，不写真实账号信息：
{"taskLabel":"test-login","outcome":"failure","symptom":"测试页面加载慢","step":"wait","resolution":"增加等待并重新观察","comment":"只读测试"}
2. listRecords 按 taskLabel、outcome、limit 过滤。
3. listExperiences，确认 failure 记录沉淀经验。
4. queryRelevant 查询“测试页面加载慢”，确认能返回相关经验。
5. markApplied 对测试经验分别标记 worked true / false，确认统计变化。
6. summary、successRate。
7. 非法 outcome、空 taskLabel、未知 experienceId 要返回清晰错误。
8. 报告中明确：该模块是本地经验回路，不是自动更新模型权重的训练系统。

【第 11 阶段：模块九 device-pool 独立测试】
无真实设备也要验证数据和调度逻辑；不要把虚构设备当成在线设备。

1. register 两台测试设备，serial 使用 TEST-A / TEST-B，transport 使用 usb / wifi，groups 使用 ["test-pool"]，maxConcurrency 设置 1。
2. list、listGroups、status。
3. tag 替换分组；setConcurrency 设为 2 后再恢复 1。
4. refresh；如果设备不存在，状态应为 offline 或明确不可用，不得伪报 online。
5. enqueue 两个只读测试 payload，分别 priority 10 和 20，并设置 groupFilter=test-pool。
6. status 检查队列顺序；autoAssign 在没有在线设备时应保持 queued 或返回明确的未分配原因。
7. 如果有安全测试设备，再 assign；否则不要强行 assign 到虚构设备。
8. 对运行中的测试任务调用 complete，分别测试 ok=true 和 ok=false + error。
9. dequeue 剩余队列任务；unregister 测试设备。
10. 验证运行中任务不能被错误注销，非法并发数和未知设备 id 必须失败。

【第 12 阶段：模块十 replay 独立测试】
1. startRecording 创建 test-replay。
2. markFrame 至少三帧：成功动作、失败动作、带 anomaly 和 recovery 的动作；在有 ADB 且用户确认时开启 captureScreenshot，否则关闭。
3. stopRecording，确认 status=ready、frames 数正确。
4. listReplays、getReplay、stats，核对 okFrames、failedFrames、anomalies。
5. annotate 给某一帧补充 decision / anomaly。
6. exportReplay format=json，解析 JSON 并确认内容完整。
7. exportReplay format=html，确认生成 path / content，HTML 包含时间线、FRAMES、上一帧 / 下一帧和异常信息。
8. 不存在的 session / frame 必须失败；removeReplay 后记录和测试截图目录清理。
9. 用浏览器或静态文件方式打开 HTML；确认不依赖外部资源且可以逐帧切换。

【第 13 阶段：组合工作流验证】
按顺序执行一条完全使用 test 数据的组合链路：

1. project-group 创建并切换 test-combination。
2. snippet-library 保存 test-health。
3. demo-recorder 录制最小示范并 stopDemo。
4. demo-recorder.toTemplate 或 action-template.save-from-demo 生成模板。
5. action-template.list / get 确认模板存在。
6. replay.startRecording 创建组合回放。
7. 执行模板；将每一步结果写入 replay.markFrame。没有设备时要明确记录 skipped / degraded。
8. replay.stopRecording 和 exportReplay HTML。
9. feedback-rl.record 记录本次结果；queryRelevant 验证经验检索。
10. device-pool.enqueue 一个带 templateId 的测试任务；没有在线设备时保持 queued，不要伪造完成。
11. scheduler.create 一个 disabled 的 daily 或 cron 任务，target 指向 test 模板；nextRuns 验证后删除。
12. workflow-marketplace.exportWorkflow 或 importWorkflow 验证模板交换格式。
13. project-group.export 导出组合项目包。
14. 切换到默认项目并确认 test-combination 数据不会污染默认项目。

组合工作流通过标准：模块之间传递的 ID、变量和结果都能被下一模块消费；失败时有明确错误，不发生静默成功或数据串项目。

【第 14 阶段：DSH 动态适配验证】
1. 先检查当前 DSH 是否已经安装和运行，以及当前 OpenGUI 插件是否存在。
2. 不要卸载现有 OpenGUI。不要替换现有 workspace。
3. 检查 OpenGUI-Plus 的 src/dsh/adapter.ts：它通过动态 import 探测 @deepseek-ai/dsh-tools，缺少宿主时应优雅降级。
4. 如果当前 DSH 支持从本地目录加载插件：
   - 优先使用单独的测试 profile / workspace，或 DSH 官方支持的 sibling plugin 方式。
   - 从本地构建产物加载 <repo>/deepseek-harness-plugin/opengui-plus。
   - 保留原版 OpenGUI 并列安装，不覆盖同名入口。
   - 使用独立 OPENGUI_PLUS_DATA_DIR 或插件数据目录。
5. 如果 DSH 不支持当前 manifest 或本地加载方式：
   - 不要猜命令，不要修改 DSH 配置。
   - 把 DSH 集成标为 BLOCKED。
   - 继续使用独立 CLI 验证全部模块，并记录需要的 DSH 官方加载方式。
6. 如果适配成功，确认工具数量大于 0，工具名形如：
   opengui_plus_wlan_connection_status
   opengui_plus_snippet_library_list
   opengui_plus_replay_list_replays
7. 在 DSH 中只调用低风险方法做冒烟：status、modules 对应的只读方法、snippet list、replay list、market browse、feedback summary、device-pool status。
8. 不要通过 DSH 自动执行真实设备点击、输入、发布或删除；如需真机动作先请求我的确认。

【第 15 阶段：真实设备测试（可选，必须先确认）】
只有满足以下条件才执行：
- ADB 能发现至少一台已授权设备。
- 我明确确认使用哪台设备和哪个测试 App。
- 测试 App 是测试包或允许自动化的应用。
- 测试步骤是只读 / 可逆的。

建议顺序：
1. adb devices -l
2. wlan-connection.discover
3. wlan-connection.status
4. 只连接指定设备
5. 截图和观察
6. 启动测试 App（如果我确认）
7. 执行 wait / screenshot / 返回等低风险动作
8. 全程 replay 记录
9. 出现登录、发送、发布、删除、购买、权限变更或账号变更时立即停止并询问

真机测试报告必须明确区分：
- 代码逻辑通过
- ADB 通道通过
- 真实 GUI 动作通过
- DSH 工具注册通过
不要因为 CLI 通过就宣称真实手机 GUI 全部通过。

【第 16 阶段：报告格式】
请生成：
1. <evidence-dir>/opengui-plus-validation-report.md
2. <evidence-dir>/opengui-plus-validation-results.json
3. 如果生成回放：<evidence-dir>/replays/*.html
4. 如果生成导出包：<evidence-dir>/exports/*，只保留脱敏后的测试数据

Markdown 报告必须包含：
- 测试时间和环境
- 仓库路径和 commit
- 是否使用本地源码 / GitHub checkout / 已安装插件
- 是否保留现有 OpenGUI（必须写明）
- 测试数据目录
- 总体结论：PASS / PASS WITH BLOCKERS / FAIL
- 汇总表：模块、测试数量、PASS、FAIL、BLOCKED
- 每个模块的详细结果
- 组合工作流结果
- DSH 集成结果
- 真机结果（如未执行写 NOT RUN，不要写 PASS）
- 证据文件列表
- 失败复现命令
- 修复建议和下一步

JSON 至少包含：
{
  "project": "OpenGUI-Plus",
  "commit": "...",
  "testedAt": "ISO-8601",
  "sourceMode": "local-source | github-checkout | installed-plugin",
  "existingOpenGuiPreserved": true,
  "dataDir": "...",
  "summary": {"pass": 0, "fail": 0, "blocked": 0},
  "tests": [
    {"id":"AT-001","area":"build","status":"PASS","evidence":[],"note":"..."}
  ]
}

【最后输出规则】
完成后不要只说“测试通过”。请先给出：
- 总体结论
- PASS / FAIL / BLOCKED 数量
- 十个模块逐项结论
- 是否验证了 DSH 工具注册
- 是否验证了真实设备
- 报告和证据路径
- 任何未验证项目及原因
如果遇到需要我授权、选择设备或确认真实动作的步骤，请停在该步骤并明确询问，不要自行绕过安全约束。
```

---

## 二、怎么使用这段提示词

### 方案 A：你有本地仓库（推荐）

1. 不卸载当前 OpenGUI。
2. 把上面整段提示词发给 DeepSeek Harness。
3. 在提示词中补充本地仓库路径，例如：

```text
本地仓库路径是：C:\Users\AYU20\WorkBuddy AI\2026-09-04-09-09-42\OpenGUI-Plus
请优先使用本地源码，不要重新下载，不要卸载现有 OpenGUI。
```

4. 让它先跑独立 CLI 和 `npm run check`。
5. 等报告完成后，再决定是否做 DSH 本地插件加载和真机验证。

### 方案 B：只有 GitHub 仓库

补充这一段：

```text
本地没有 OpenGUI-Plus 源码。请把 https://github.com/code-sxs/OpenGUI-Plus checkout 到临时测试目录，使用 main 最新版本进行验证。不要修改或卸载当前已经安装的 OpenGUI / DSH。请把测试数据放到独立临时目录，并保留源码目录和报告。
```

### 方案 C：已经安装了 OpenGUI-Plus

补充这一段：

```text
当前机器可能已经安装 OpenGUI-Plus。请先识别已安装版本和加载方式。不要卸载、覆盖或替换现有 OpenGUI-Plus。优先复用已安装代码做 DSH 冒烟，同时使用独立 TEST_DATA_DIR 做数据和模块测试。如果无法确认安装目录，就使用本地源码或临时 checkout 做独立验证，并把 sourceMode 写清楚。
```

---

## 三、验收标准怎么判

### PASS

满足以下条件才算单项 PASS：

- 方法返回结构正确。
- 数据写入后能读回。
- 重启或重新创建 host 后数据仍在。
- 非法输入有明确错误且不破坏旧数据。
- 没有设备时正确返回降级 / skipped，而不是伪装成功。
- 有设备时，真实状态和返回结果一致。

### BLOCKED

以下情况应该标 BLOCKED，不是 FAIL：

- 没有 Android 设备，所以无法做真机动作。
- DSH 当前版本不支持本地 sibling plugin 加载。
- 受限环境不能安装依赖，但源码结构已经检查。
- 没有权限访问某个外部服务或设备。

### FAIL

以下情况才算 FAIL：

- typecheck、test 或 build 失败。
- 模块方法崩溃或无响应。
- 保存后数据丢失。
- 项目切换导致数据串项目。
- 非法输入破坏已有数据。
- HTML 回放生成但无法打开或内容缺失。
- DSH 已成功加载插件，但工具注册数量为 0 或调用时报错。

---

## 四、我给你的实际建议

你现在**不需要卸载已经安装好的 OpenGUI**。最稳的顺序是：

```text
本地源码验证
  ↓
npm run check
  ↓
独立 TEST_DATA_DIR 验证十模块
  ↓
组合工作流验证
  ↓
让 DeepSeek Harness 做 DSH 动态注册冒烟
  ↓
最后才做指定 Android 设备的低风险真机验证
```

先让 DeepSeek Harness 测试“增强层逻辑和 DSH 注册”，不要一上来就让它替换现有 OpenGUI 或执行真实账号操作。这样即使增强版某个模块失败，也不会影响你当前已经能用的 OpenGUI 环境。
