import { useState } from 'react';
import { Check, Copy, FileText } from 'lucide-react';
import { generatedImageCaption as captionParts, type MessageGeneratedImage } from '../shared/image-generation';
import type { Attachment } from '../shared/types';
import { AttachmentThumbnail } from './AttachmentThumbnail';
import { attachmentContentUrl, attachmentSize, copyAttachmentImage } from './attachments';
import { ImageViewer } from './ImageViewer';
import type { MarkupResult } from './ImageMarkup';
import { shownName, withNames } from './i18n';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** “由 Codex · 本机 内置生图生成” or “由 OpenAI · gpt-image-2.5 生成”: the image model only when the tool reported it. */
export const generatedImageCaption = (
  images: readonly Pick<MessageGeneratedImage, 'executor' | 'imageModel' | 'edit'>[],
) =>
  captionParts(images, shownName)
    .map((part) => withNames(part.sentence, part.names))
    .join(' · ');

/** A message's attachments: image thumbnails open the shared viewer, files download. Chat and Trace › Result use it. */
export function MessageAttachments({
  conversationId,
  attachments,
  onMarkup,
}: {
  conversationId: string;
  attachments: Attachment[];
  onMarkup?: (result: MarkupResult) => boolean;
}) {
  const [copyState, setCopyState] = useState<{ id: string; busy?: boolean; copied?: boolean; error?: string }>();
  const [viewing, setViewing] = useState<number>();
  const images = attachments.filter((attachment) => attachment.kind === 'image');
  function copyImage(attachment: Attachment) {
    if (copyState?.busy) return;
    const pending = copyAttachmentImage(conversationId, attachment);
    setCopyState({ id: attachment.id, busy: true });
    void pending.then(
      () => setCopyState({ id: attachment.id, copied: true }),
      (error) => setCopyState({ id: attachment.id, error: errorText(error) }),
    );
  }
  return (
    <div className="message-attachments" aria-label="消息附件">
      {attachments.map((attachment) =>
        attachment.kind === 'image' ? (
          <button
            type="button"
            className="message-attachment-link"
            key={attachment.id}
            title={withNames('查看大图 {0}', [attachment.name])}
            aria-label={attachment.name}
            data-names
            onClick={(event) => {
              event.currentTarget.focus();
              setViewing(images.indexOf(attachment));
            }}
          >
            <AttachmentThumbnail
              size="message"
              src={attachmentContentUrl(conversationId, attachment.id)}
              alt={attachment.name}
            />
          </button>
        ) : (
          <a
            className="message-attachment"
            key={attachment.id}
            href={attachmentContentUrl(conversationId, attachment.id)}
            download={attachment.name}
            aria-label={attachment.name}
            title={withNames('下载 {0}', [attachment.name])}
            data-names
          >
            <FileText size={20} />
            <span>
              <strong translate="no" title={attachment.name}>
                <span>{attachment.name.slice(0, -8)}</span>
                <span>{attachment.name.slice(-8)}</span>
              </strong>
              <small>{attachmentSize(attachment.size)}</small>
            </span>
          </a>
        ),
      )}
      {viewing !== undefined && (
        <ImageViewer
          images={images.map((attachment) => ({
            src: attachmentContentUrl(conversationId, attachment.id),
            name: attachment.name,
            detail: attachmentSize(attachment.size),
          }))}
          index={viewing}
          markup={onMarkup ? { kind: 'image', onAdd: onMarkup } : undefined}
          onIndex={setViewing}
          onClose={() => setViewing(undefined)}
          actions={(_, index) => {
            const attachment = images[index]!;
            const state = copyState?.id === attachment.id ? copyState : undefined;
            return (
              <button
                type="button"
                className="button tiny quiet attachment-copy"
                aria-label={withNames('复制图片 {0}', [attachment.name])}
                data-names
                disabled={state?.busy}
                onClick={() => copyImage(attachment)}
                title={state?.error}
              >
                {state?.copied ? <Check size={13} /> : <Copy size={13} />}
                {state?.copied ? '已复制' : state?.error ? '复制失败' : '复制图片'}
              </button>
            );
          }}
        />
      )}
    </div>
  );
}
