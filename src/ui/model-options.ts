import type { ModelInfo } from '../shared/types';

export const newModelTitle = '供应商已列出此模型，但模型目录尚未收录。价格未知，仅供手动选择。';
export const modelOptionLabel = (model: ModelInfo) =>
  model.discovered ? `${model.label} · 新模型 · 价格未知` : model.label;
