/**
 * 轻量 i18n 字典。
 *
 * DICT 字典覆盖 Studio 各面板 + chat-panel 用户可见文案。
 * 各组件用 t("key") 替代硬编码中文。STATUS_LABEL / TOOL_LABELS 保留独立导出（高频共享）。
 *
 * 单语言（zh）字典 + t() 函数；不引入 i18n 框架。
 *
 * 用法：
 * import { t, STATUS_LABEL, TOOL_LABELS } from "@/lib/i18n";
 * STATUS_LABEL[thread.status] // "执行中"
 * t("studio.subagent.empty") // "当前 thread 无子代理。"
 *
 * 缺 key 回退：t() 返回 key 本身（fail-open,不抛），便于发现遗漏。
 */

/** Thread 状态标签（各页面/面板共享）。 */
export const STATUS_LABEL: Record<string, string> = {
  idle: "空闲",
  executing: "执行中",
  ready_for_review: "待审核",
  failed: "失败",
  planning: "规划中",
  awaiting_input: "等待输入",
  awaiting_approval: "待审批",
  delivering: "交付中",
  completed: "已交付",
  verifying: "验证中",
  cancelled: "已取消",
};

/**
 * 子代理 run 状态标签（subagent-panel 共享,收敛局部硬编码字典）。
 * 与 thread STATUS_LABEL 不同——subagent run 有独立的 queued/timed_out 态。
 */
export const SUBAGENT_STATUS_LABEL: Record<string, string> = {
  queued: "排队",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "超时",
};

/** plan item 状态标签（thread-plan-panel 共享）。 */
export const PLAN_ITEM_STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** deployment 状态标签（deployment-panel 共享）。 */
export const DEPLOYMENT_STATUS_LABEL: Record<string, string> = {
  deployed: "已部署",
  deploying: "部署中",
  pending: "等待中",
  failed: "失败",
  rolled_back: "已回滚",
};

/** 便捷：取 SUBAGENT_STATUS_LABEL。 */
export function subagentStatusLabel(status: string): string {
  return SUBAGENT_STATUS_LABEL[status] ?? status;
}

/** 便捷：取 PLAN_ITEM_STATUS_LABEL。 */
export function planItemStatusLabel(status: string): string {
  return PLAN_ITEM_STATUS_LABEL[status] ?? status;
}

/** 便捷：取 DEPLOYMENT_STATUS_LABEL。 */
export function deploymentStatusLabel(status: string): string {
  return DEPLOYMENT_STATUS_LABEL[status] ?? status;
}

/** 工具显示名（chat-panel / tool-trace 共享）。 */
export const TOOL_LABELS: Record<string, string> = {
  writeFile: "写入文件",
  editFile: "编辑文件",
  multiEditFile: "批量编辑",
  applyPatch: "应用补丁",
  deleteFile: "删除文件",
  readFile: "读取文件",
  readFileRange: "分段读取",
  statFile: "文件信息",
  glob: "文件搜索",
  grep: "内容搜索",
  listFiles: "列出文件",
  runCommand: "运行命令",
  runTests: "运行测试",
  runBuild: "构建",
  installDependencies: "安装依赖",
  reportReady: "提交预览自检",
  startPreview: "启动预览",
  stopPreview: "停止预览",
  getPreviewStatus: "预览状态",
  gitStatus: "Git 状态",
  gitDiff: "Git 差异",
  gitCheckpoint: "创建检查点",
  gitRestoreCheckpoint: "恢复检查点",
  gitCreateBranch: "创建分支",
  gitCommit: "提交",
  gitPush: "推送",
  createPullRequest: "创建 PR",
  deliverySummary: "交付摘要",
  rememberFact: "记忆事实",
  webFetch: "抓取网页",
  webSearch: "网络搜索",
  searchDocs: "搜索文档",
  listMcpTools: "列出 MCP 工具",
  callMcpTool: "调用 MCP 工具",
  capturePreview: "预览截图",
  runBrowserCheck: "浏览器检查",
  runResponsiveCheck: "响应式检查",
  runAccessibilitySmoke: "a11y 检查",
  visualVerdict: "视觉评审",
  deployToEnvironment: "部署",
  deployStatus: "部署状态",
  rollback: "回滚",
  // V9 阶段 6：AI 浏览器工具
  browserGetTabs: "浏览器标签页",
  browserSnapshot: "页面快照",
  browserGetConsole: "控制台消息",
  browserGetNetwork: "网络请求",
  browserScreenshot: "页面截图",
  browserGetPageText: "页面文本",
  browserNavigate: "导航",
  browserClick: "点击",
  browserType: "输入文本",
  browserScroll: "滚动",
  browserPressKey: "按键",
  browserSelectOption: "选择选项",
  // V9 阶段 8：下载与上传工具
  browserListDownloads: "下载记录",
  browserUploadFile: "上传文件",
};

/**
 * 翻译函数（轻量,后续可扩展嵌套 key / 插值 / 复数）。
 * @param key 字典 key（如 "studio.subagent.empty"）
 * @returns 翻译文本；缺 key 返回 key 本身（fail-open,不抛）
 */
const DICT: Record<string, string> = {
  // ─── common ──────────────────────────────────────
  "common.refreshing": "实时刷新中",
  "common.realtime": "实时",
  "common.empty": "暂无数据",
  "common.error": "出错了",
  "common.retry": "重试",
  "common.cancel": "取消",
  "common.confirm": "确认",
  "common.loading": "加载中…",
  "common.detail": "详情",
  "common.view_all": "查看全部",
  "common.created": "创建",
  "common.updated": "更新",

  // ─── chat ────────────────────────────────────────
  "chat.empty.title": "想聊点什么？",
  "chat.empty.subtitle":
    "有什么我可以帮你的吗？无论是编写代码、回答问题，还是讨论想法，我随时准备着。",
  "chat.placeholder.send": "描述你想做的项目…（Shift+Enter 换行）",
  "chat.placeholder.newline": "描述你想做的项目…（⌘Enter 发送）",
  "chat.stop": "停止生成",
  "chat.sending": "发送中...",
  "chat.connection.reconnecting": "连接中断，正在重连…",
  "chat.connection.failed": "连接已断开且重连失败，请重试",
  "chat.error.default": "连接失败，请重试",
  "chat.error.generate_failed": "生成失败，请重试或调整需求",
  "chat.scroll_to_bottom": "回到底部",
  "chat.upload.attach": "上传附件（支持图片 PNG/JPG/GIF/WebP 及 PDF/DOCX/PPTX/XLSX/TXT/MD 等文档）",
  "chat.upload.max_files": "单次最多 {n} 个文件",
  "chat.upload.too_large": "{name} 超过 20MB 限制",
  "chat.upload.network_error": "网络错误，上传失败：{name}",
  "chat.upload.failed": "上传失败：{name}",
  "chat.chars": "字符",

  // ─── studio nav ──────────────────────────────────
  "studio.nav.title": "Agent Studio",
  "studio.nav.overview": "总览",
  "studio.nav.agents": "智能体",
  "studio.nav.capabilities": "能力与知识",
  "studio.nav.conversations": "会话与协作",
  "studio.nav.runtime": "Runtime 与环境",
  "studio.nav.observability": "观测与评测",
  "studio.nav.security": "安全与审计",
  "studio.nav.operations": "运营",
  "studio.nav.settings": "平台设置",
  "studio.nav.open": "展开导航",
  "studio.nav.close": "收起导航",

  // ─── studio overview page ────────────────────────
  "studio.overview.title": "总览",
  "studio.overview.scope.self": "自己",
  "studio.overview.scope.global": "全局",
  "studio.overview.scope.global_tag": "（全局）",
  "studio.overview.section.resources": "资源概况",
  "studio.overview.section.metrics": "运营指标",
  "studio.overview.section.recent_threads": "最近会话",
  "studio.overview.section.recent_artifacts": "最近产物",
  "studio.overview.section.analysis": "分析详情",
  "studio.overview.section.policy": "安全策略",
  "studio.overview.metric.active_skills": "技能（启用中）",
  "studio.overview.metric.agents": "智能体",
  "studio.overview.metric.threads": "会话",
  "studio.overview.metric.threads_self": "仅自己的",
  "studio.overview.metric.threads_global": "全局视角",
  "studio.overview.metric.agents_sub": "只读档案",
  "studio.overview.metric.thread_success": "会话成功率",
  "studio.overview.metric.preview_success": "预览成功率",
  "studio.overview.metric.avg_completion": "平均完成时长",
  "studio.overview.metric.policy_intercept": "策略拦截率",
  "studio.overview.empty.threads": "暂无会话。",
  "studio.overview.empty.artifacts": "暂无产物。",
  "studio.overview.empty.tool_failures": "无失败记录。",
  "studio.overview.empty.skill_threads": "暂无 skill 绑定的 thread 数据。",
  "studio.overview.empty.skill_matches": "暂无自动匹配记录。",
  "studio.overview.artifact.created": "创建",
  "studio.overview.artifact.updated": "更新",
  "studio.overview.tool_failures": "工具失败分布",
  "studio.overview.skill_performance": "各技能表现",
  "studio.overview.skill_matches": "自动匹配命中",
  "studio.overview.policy_summary": "策略摘要",
  "studio.overview.policy.configured": "已配置",
  "studio.overview.policy.not_configured": "未配置",

  // ─── studio threads list page ────────────────────
  "studio.threads.title": "会话",
  "studio.threads.empty": "暂无会话。",
  "studio.threads.col.thread": "会话",
  "studio.threads.col.status": "状态",
  "studio.threads.col.skill": "技能",
  "studio.threads.col.created": "创建时间",
  "studio.threads.col.owner": "所有者",

  // ─── subagent panel ──────────────────────────────
  "studio.subagent.loading": "加载子代理…",
  "studio.subagent.load_failed": "加载失败：{error}",
  "studio.subagent.empty": "当前 thread 无子代理。",
  "studio.subagent.goal": "目标",
  "studio.subagent.result": "结果",
  "studio.subagent.error": "错误",
  "studio.subagent.write_scope": "写范围",
  "studio.subagent.cancel": "取消",
  "studio.subagent.cancelling": "取消中…",
  "studio.subagent.transcript": "transcript",
  "studio.subagent.created": "创建",
  "studio.subagent.finished": "完成",

  // ─── approval panel ──────────────────────────────
  "studio.approval.loading": "加载审批…",
  "studio.approval.empty": "当前 thread 无待审批请求。",
  "studio.approval.scope_label": "批准复用范围：",
  "studio.approval.approve": "批准",
  "studio.approval.deny": "拒绝",
  "studio.approval.history": "历史决议",
  "studio.approval.resolved_approved": "✓ 批准",
  "studio.approval.resolved_denied": "✗ 拒绝",

  // ─── background task panel ───────────────────────
  "studio.task.loading": "加载后台任务…",
  "studio.task.empty": "当前 thread 无后台任务。",

  // ─── qa panel ────────────────────────────────────
  "studio.qa.empty": "当前会话无 QA 证据。",
  "studio.qa.passed": "✓ 通过",
  "studio.qa.failed": "✗ 失败",
  "studio.qa.viewports": "viewport",
  "studio.qa.report_json": "查看完整报告 JSON",

  // ─── thread auto refresh ─────────────────────────
  "studio.auto_refresh.label": "实时刷新中",
};

/**
 * 翻译函数（支持 {placeholder} 插值）。
 * @param key 字典 key（如 "studio.subagent.empty"）
 * @param vars 可选插值变量（如 { error: "HTTP 500" } 替换 {error}）
 * @returns 翻译文本；缺 key 返回 key 本身（fail-open,不抛）
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const template = DICT[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}

/** 便捷：取 STATUS_LABEL。 */
export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

/** 便捷：取 TOOL_LABELS。 */
export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}
