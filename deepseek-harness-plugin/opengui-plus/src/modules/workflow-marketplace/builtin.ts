/**
 * Seed catalogue shipped with the marketplace.
 *
 * ⚠️ 这些全部是**示例数据**（sample data）。
 *
 * They exist so a fresh install has something to browse, install and run, and
 * so the importer/validator has realistic documents to test against. The step
 * coordinates are illustrative: real phones differ, and a user is expected to
 * re-record a template with `demo-recorder` before relying on it. Nothing here
 * contacts a real service or hard-codes credentials.
 *
 * Seeded templates are read-only. Installing one copies it into
 * `market-installed`; publishing writes to `market-published`.
 *
 * @module modules/workflow-marketplace/builtin
 */

import type { WorkflowTemplate } from './schema.js'

const SEED_CREATED_AT = '2026-01-05T00:00:00.000Z'

export const BUILTIN_WORKFLOWS: readonly WorkflowTemplate[] = [
  {
    formatVersion: 1,
    id: 'builtin-xhs-note-collect',
    name: '小红书笔记点赞与评论采集',
    description: '按关键词搜索小红书笔记，逐条打开采集点赞数与热门评论，结果写入采集清单。',
    category: 'social-operations',
    author: 'OpenGUI-Plus 示例',
    version: '1.0.0',
    tags: ['小红书', '点赞', '评论', '关键词'],
    taskIntent: '搜索指定关键词的小红书笔记，采集前 N 篇笔记的点赞、收藏、评论数以及前 3 条热门评论。',
    preconditions: [
      '设备已开启 USB 调试并授权',
      '已安装小红书并登录账号',
      '建议关闭省电模式，避免采集中息屏',
    ],
    steps: [
      { id: 's1', action: 'launch', params: { package: 'com.xingin.xhs' }, note: '冷启动小红书' },
      { id: 's2', action: 'wait', params: { ms: 3000 }, note: '等待首页渲染' },
      { id: 's3', action: 'tap', params: { x: 540, y: 180 }, note: '点击搜索框' },
      { id: 's4', action: 'input', params: { text: '{{关键词}}' } },
      { id: 's5', action: 'keyevent', params: { code: 66 }, note: '回车搜索' },
      { id: 's6', action: 'wait', params: { ms: 2500 } },
      { id: 's7', action: 'tap', params: { x: 270, y: 800 }, note: '打开第 1 篇笔记' },
      { id: 's8', action: 'wait', params: { ms: 2000 } },
      { id: 's9', action: 'collect', params: { fields: 'likes,collects,comments' }, note: '采集当前页指标' },
      { id: 's10', action: 'swipe', params: { x1: 540, y1: 1600, x2: 540, y2: 600, duration: 400 }, note: '滚动评论区' },
      { id: 's11', action: 'collect', params: { fields: 'topComments', limit: 3 } },
      { id: 's12', action: 'keyevent', params: { code: 4 }, note: '返回列表' },
    ],
    parameters: [
      { name: '关键词', label: '搜索关键词', description: '在小红书搜索框中输入的关键词', defaultValue: '露营装备', required: true },
      { name: '采集条数', label: '采集笔记条数', description: '采集前多少篇笔记，默认 10', defaultValue: '10', required: false },
    ],
    stats: { downloads: 128, ratingSum: 21, ratingCount: 5 },
    createdAt: SEED_CREATED_AT,
    updatedAt: SEED_CREATED_AT,
  },
  {
    formatVersion: 1,
    id: 'builtin-app-cold-start',
    name: 'App 冷启动耗时测试',
    description: '多轮强制停止并冷启动目标 App，记录每轮启动耗时，输出平均值与 P95。',
    category: 'app-testing',
    author: 'OpenGUI-Plus 示例',
    version: '1.1.0',
    tags: ['性能测试', '冷启动', '耗时', 'P95'],
    taskIntent: '对目标包名执行 N 轮冷启动，抓取 am start 上报的 TotalTime，计算平均值、最大值与 P95。',
    preconditions: [
      '设备已开启 USB 调试并授权',
      '目标 App 已安装且可正常启动',
      '测试期间不要操作手机，避免干扰耗时',
    ],
    steps: [
      { id: 's1', action: 'shell', params: { command: 'am force-stop {{包名}}' }, note: '确保进程已退出' },
      { id: 's2', action: 'wait', params: { ms: 1500 } },
      { id: 's3', action: 'shell', params: { command: 'am start -W -n {{包名}}/{{启动Activity}}' }, note: '带 -W 输出 TotalTime' },
      { id: 's4', action: 'collect', params: { fields: 'TotalTime' } },
      { id: 's5', action: 'shell', params: { command: 'input keyevent 3' }, note: '回到桌面准备下一轮' },
      { id: 's6', action: 'wait', params: { ms: 1000 } },
    ],
    parameters: [
      { name: '包名', label: '目标包名', description: '被测 App 的 applicationId', defaultValue: 'com.example.app', required: true },
      { name: '启动Activity', label: '启动 Activity', description: '冷启动入口 Activity 全名', defaultValue: '.MainActivity', required: true },
      { name: '轮次', label: '测试轮次', description: '执行多少轮冷启动，默认 10', defaultValue: '10', required: false },
    ],
    stats: { downloads: 74, ratingSum: 18, ratingCount: 4 },
    createdAt: SEED_CREATED_AT,
    updatedAt: SEED_CREATED_AT,
  },
  {
    formatVersion: 1,
    id: 'builtin-daily-health-checkin',
    name: '每日健康打卡自动填报',
    description: '打开企业健康申报页，填写体温与当前所在地，勾选承诺项后提交并截图留证。',
    category: 'auto-checkin',
    author: 'OpenGUI-Plus 示例',
    version: '1.0.2',
    tags: ['打卡', '健康申报', '定时任务'],
    taskIntent: '每日固定时间打开健康申报页面，填入体温与所在地，勾选承诺后提交，并截图保存凭证。',
    preconditions: [
      '设备已开启 USB 调试并授权',
      '已安装申报入口 App 并登录',
      '配合 scheduler 模块设置每日触发时间',
    ],
    steps: [
      { id: 's1', action: 'launch', params: { package: '{{申报App包名}}' } },
      { id: 's2', action: 'wait', params: { ms: 2500 } },
      { id: 's3', action: 'tap', params: { x: 540, y: 640 }, note: '进入健康申报' },
      { id: 's4', action: 'input', params: { text: '{{体温}}' } },
      { id: 's5', action: 'tap', params: { x: 540, y: 980 }, note: '选择所在地' },
      { id: 's6', action: 'input', params: { text: '{{所在地}}' } },
      { id: 's7', action: 'tap', params: { x: 180, y: 1240 }, note: '勾选承诺项' },
      { id: 's8', action: 'tap', params: { x: 540, y: 1420 }, note: '点击提交' },
      { id: 's9', action: 'wait', params: { ms: 1500 } },
      { id: 's10', action: 'screenshot', params: { name: 'checkin-proof' }, note: '保存打卡凭证' },
    ],
    parameters: [
      { name: '申报App包名', label: '申报 App 包名', defaultValue: 'com.example.health', required: true },
      { name: '体温', label: '体温数值', description: '如 36.5', defaultValue: '36.5', required: true },
      { name: '所在地', label: '当前所在地', defaultValue: '深圳市南山区', required: true },
    ],
    stats: { downloads: 213, ratingSum: 25, ratingCount: 6 },
    createdAt: SEED_CREATED_AT,
    updatedAt: SEED_CREATED_AT,
  },
  {
    formatVersion: 1,
    id: 'builtin-competitor-price-collect',
    name: '竞品商品价格数据采集',
    description: '在电商 App 中按关键词搜索，逐条记录商品名、价格、销量与店铺名。',
    category: 'data-collection',
    author: 'OpenGUI-Plus 示例',
    version: '1.0.0',
    tags: ['电商', '比价', '采集', '竞品'],
    taskIntent: '搜索关键词后按顺序打开前 N 个商品，采集商品标题、价格、月销量与店铺名，汇成一张比价表。',
    preconditions: [
      '设备已开启 USB 调试并授权',
      '已安装目标电商 App 并登录',
      '网络稳定，避免列表加载不全',
    ],
    steps: [
      { id: 's1', action: 'launch', params: { package: '{{电商App包名}}' } },
      { id: 's2', action: 'wait', params: { ms: 3000 } },
      { id: 's3', action: 'tap', params: { x: 540, y: 160 } },
      { id: 's4', action: 'input', params: { text: '{{关键词}}' } },
      { id: 's5', action: 'keyevent', params: { code: 66 } },
      { id: 's6', action: 'wait', params: { ms: 2500 } },
      { id: 's7', action: 'collect', params: { fields: 'title,price,monthlySales,shop' }, note: '采集列表可见字段' },
      { id: 's8', action: 'swipe', params: { x1: 540, y1: 1700, x2: 540, y2: 500, duration: 500 }, note: '翻到下一屏' },
      { id: 's9', action: 'collect', params: { fields: 'title,price,monthlySales,shop' } },
    ],
    parameters: [
      { name: '电商App包名', label: '电商 App 包名', defaultValue: 'com.example.mall', required: true },
      { name: '关键词', label: '搜索关键词', defaultValue: '机械键盘', required: true },
      { name: '采集页数', label: '采集页数', description: '向下翻多少屏，默认 3', defaultValue: '3', required: false },
    ],
    stats: { downloads: 96, ratingSum: 16, ratingCount: 4 },
    createdAt: SEED_CREATED_AT,
    updatedAt: SEED_CREATED_AT,
  },
  {
    formatVersion: 1,
    id: 'builtin-batch-screenshot-archive',
    name: '批量截图与归档',
    description: '依次打开多个页面并截图，按序号命名保存到数据目录，便于归档与人工复核。',
    category: 'other',
    author: 'OpenGUI-Plus 示例',
    version: '1.0.0',
    tags: ['截图', '归档', '巡检'],
    taskIntent: '按顺序遍历若干页面，每个页面等待稳定后截图并命名归档，用于 UI 巡检或留证。',
    preconditions: [
      '设备已开启 USB 调试并授权',
      '数据目录有足够磁盘空间',
    ],
    steps: [
      { id: 's1', action: 'wait', params: { ms: 800 } },
      { id: 's2', action: 'screenshot', params: { name: '{{前缀}}-01' } },
      { id: 's3', action: 'swipe', params: { x1: 540, y1: 1600, x2: 540, y2: 700, duration: 400 } },
      { id: 's4', action: 'wait', params: { ms: 800 } },
      { id: 's5', action: 'screenshot', params: { name: '{{前缀}}-02' } },
    ],
    parameters: [
      { name: '前缀', label: '文件名前缀', defaultValue: 'archive', required: false },
    ],
    stats: { downloads: 41, ratingSum: 9, ratingCount: 2 },
    createdAt: SEED_CREATED_AT,
    updatedAt: SEED_CREATED_AT,
  },
]
