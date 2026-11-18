export const settingsCategories = (
  [
    { id: 'general', name: '通用', description: '外观、语言和这台电脑上的启动方式。' },
    { id: 'account', name: '账号', description: '跨设备自动同步对话和偏好设置。' },
    { id: 'personal', name: '个性化', description: '告诉 AI 你想要的回答方式，以及它能记住什么。' },
    { id: 'conversation', name: '对话', description: '发消息的方式，以及归档和删除的对话。' },
    { id: 'routing', name: '智能路由', description: 'PugPort 怎样为每条消息挑选账号、模型和思考强度。' },
    {
      id: 'devices',
      name: '设备',
      description: '把家里的其他电脑加进来替你跑任务。',
    },
    { id: 'permissions', name: '权限与安全', description: 'AI 运行命令、改文件和删文件之前要不要先问你。' },
    { id: 'advanced', name: '高级', description: '很少需要改的运行参数。' },
  ] as const
).map((category, order) => ({ ...category, order }));

export type SettingsCategory = (typeof settingsCategories)[number]['id'];

export function settingsCategory(value: string): SettingsCategory {
  return settingsCategories.find((category) => category.id === value)?.id ?? 'general';
}
