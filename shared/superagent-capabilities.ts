export interface SuperagentCapabilities {
  runtime: "official-superagent";
  features: Array<{ id: string; label: string; available: boolean; reason?: string }>;
}

export const SUPERAGENT_CAPABILITIES: SuperagentCapabilities = {
  runtime: "official-superagent",
  features: [
    { id: "chat", label: "原聊天与会话", available: true },
    { id: "memory", label: "原记忆与资料", available: true },
    { id: "background-decisions", label: "后台任务审批与提问", available: true },
    { id: "native-tools", label: "DSH 原生工具", available: true },
    { id: "connected-apps", label: "原 Connected Apps 工具", available: false, reason: "尚未挂载到 DSH；连接记录保留。" },
    { id: "computer", label: "原浏览器与桌面工具", available: false, reason: "当前托管 profile 未接入这些工具。" },
    { id: "automations", label: "原自动化执行器", available: false, reason: "当前模式由 Super Agent 执行任务，旧执行器已停用。" },
    { id: "plugin-installer", label: "App 内插件安装", available: false, reason: "尚未提供安装管理入口。" },
    { id: "external-gateway", label: "外部 DSH 网关", available: false, reason: "当前使用本机托管运行时。" },
    { id: "isolated-task-workspaces", label: "每任务独立工作目录与合并", available: false, reason: "当前通过宿主写入协调保护共享目录，尚未提供自动 worktree 与合并。" },
    { id: "coordinated-backup", label: "一键系统备份与恢复", available: false, reason: "原 App 导出不包含 Personbot home 和宿主资源数据库，目前需要配套手动备份。" },
  ],
};
