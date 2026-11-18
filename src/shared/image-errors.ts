/** Safe display messages for transport failures; never expose raw image payloads. */
export const imageInputErrors: Readonly<Record<string, string>> = {
  'runtime-image-input-unavailable': '当前执行器的图片输入通道不可用。',
  'runtime-image-input-invalid':
    '图片无法读取、内容为空、格式不受支持或超过大小限制，请重新添加 PNG、JPEG、WebP 或 GIF 图片。',
  'runtime-image-dropped': '当前执行器未能接收完整图片。',
};
