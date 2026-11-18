import type { Api, Notice } from './Workspace';

export async function exportConversation(
  api: Api,
  notify: (notice: Notice) => void,
  id: string,
  format: 'md' | 'json',
) {
  const { fileName, mimeType, content } = await api<{ fileName: string; mimeType: string; content: string }>(
    `/api/conversations/${encodeURIComponent(id)}/export?format=${format}`,
    undefined,
    'GET',
  );
  const objectUrl = URL.createObjectURL(new Blob([content], { type: mimeType }));
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = fileName;
    link.click();
    notify({ tone: 'success', message: `已开始导出：${fileName}` });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
