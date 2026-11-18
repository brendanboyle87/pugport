import type { ModPermission } from './mods-manifest.ts';

/** What each Mod permission lets it do, in the words the Store, the chat approval card and mod_load show. */
export const modPermissionText: Partial<Record<ModPermission, string>> = {
  'model:run': '用你的 AI 账号运行模型，并把结果存回这个 Mod。用量照常计入。',
  'voice:session': '在你打开它时使用麦克风和朗读。界面会显示「麦克风已开启」，随时可以停止。',
  'connections:read': '读取你在 PugPort 里授权给它的银行账户、余额、交易和信用卡账单。银行密码和密钥不会交给它。',
  'data:store': '在本机保存自己的数据，与对话分开；删除对话不会删除这些数据。',
  'files:import': '在你选择文件时读取那个文件。',
  'chat:read': '读取这个对话的消息。',
  'composer:draft': '在输入框里填写草稿，不会代你发送。',
};
