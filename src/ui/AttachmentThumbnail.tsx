import { useEffect, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { attachmentThumbnail } from './attachments';

/** Only the small decoded bitmap reaches <img>; originals are decoded by ImageViewer on demand. */
export function AttachmentThumbnail({
  src,
  alt = '',
  size = 'draft',
}: {
  src: string;
  alt?: string;
  size?: 'draft' | 'message';
}) {
  const ref = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState<string>();
  const [ready, setReady] = useState<string>();
  const [preview, setPreview] = useState<{ source: string; url: string }>();
  useEffect(() => {
    let active = true,
      started = false,
      url: string | undefined;
    const controller = new AbortController();
    const load = async () => {
      if (started) return;
      started = true;
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error('Preview unavailable');
        const blob = await attachmentThumbnail(await response.blob(), size);
        if (active) {
          url = URL.createObjectURL(blob);
          setPreview({ source: src, url });
        }
      } catch {
        if (active) setFailed(src);
      }
    };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void load();
      }
    });
    if (ref.current) observer.observe(ref.current);
    return () => {
      active = false;
      controller.abort();
      observer.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, size]);
  // alt is the attachment's file name, kept as written.
  return (
    <span className={`attachment-thumbnail ${ready === src ? 'ready' : failed === src ? 'failed' : 'loading'}`}>
      <img
        ref={ref}
        src={preview?.source === src ? preview.url : undefined}
        alt={alt}
        width={size === 'message' ? 112 : 56}
        height={size === 'message' ? 112 : 56}
        onLoad={() => setReady(src)}
        onError={() => setFailed(src)}
        data-names
      />
      {failed === src && <ImageOff size={24} aria-hidden="true" />}
    </span>
  );
}
