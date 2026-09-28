'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import 'react-quill-new/dist/quill.bubble.css';
import '../editor-table.css';
import '../editor-canvas.css';
import '@/app/blog-enhancements.css'; // graphic block styles — match the published look in-canvas
import Link from 'next/link';
import CodeLanguagePicker from '@/components/blog-editor/CodeLanguagePicker';
import AuthorPicker from '@/components/blog-editor/AuthorPicker';
import FaqRepeater from '@/components/blog-editor/FaqRepeater';
import TakeawaysRepeater from '@/components/blog-editor/TakeawaysRepeater';
import RelatedPicker from '@/components/blog-editor/RelatedPicker';
import TocEditor, { type TocOverride } from '@/components/blog-editor/TocEditor';
import VersionHistory from '@/components/blog-editor/VersionHistory';
import { slugify } from '@/lib/blog-content/slugify';
import GraphicEditorModal from '@/components/blog-editor/graphics/GraphicEditorModal';
import { decodeConfig } from '@/lib/blog-content/graphics/encode';
import type { GraphicConfig } from '@/lib/blog-content/graphics/types';
import { useSite } from '@/components/admin/site-provider';
import { uploadImageDirect } from '@/lib/media/upload-client';
import {
  CLIENT_UPLOAD_OUTPUT_TYPE,
  CLIENT_UPLOAD_TARGET_BYTES,
  compressedFileFrom,
  shouldCompressOnClient,
} from '@/lib/media/compress-output';

const ReactQuill = dynamic(
  async () => {
    // react-quill-new bundles Quill — access it as a named export from the same module
    const rqMod = await import('react-quill-new');
    const RQ = rqMod.default;
    const Quill = (rqMod as any).Quill ?? (RQ as any).Quill;

    // Register a custom BlockEmbed blot so Quill natively understands <hr> dividers.
    // Without this registration, Quill's delta converter silently drops <hr>.
    if (Quill) {
      try {
        const BlockEmbed = Quill.import('blots/block/embed') as any;

        class DividerBlot extends BlockEmbed {
          static blotName = 'divider';
          static tagName = 'hr';
          static create() {
            const node = super.create() as HTMLElement;
            node.setAttribute('data-divider', 'true');
            return node;
          }
          static value() {
            return true;
          }
        }

        Quill.register(DividerBlot);
      } catch {
        // Already registered — skip silently
      }

      try {
        const { registerCodeLanguageBlot } = await import('@/lib/quill/code-language-blot');
        registerCodeLanguageBlot(Quill);
      } catch {
        // Already registered or unsupported — code blocks still work without a language
      }

      try {
        const { registerGraphicBlot } = await import('@/lib/quill/graphic-blot');
        registerGraphicBlot(Quill);
      } catch {
        // Already registered or unsupported — editor works without graphics
      }
    }

    const QuillWithRef = React.forwardRef<any, any>((props, ref) => <RQ {...props} ref={ref} />);
    QuillWithRef.displayName = 'QuillWithRef';
    return QuillWithRef;
  },
  { ssr: false },
);

const CLIENT_UPLOAD_MAX_DIMENSION = 2240;
const CLIENT_UPLOAD_MIN_QUALITY = 0.55;

interface EditorBlogPayload {
  title?: string;
  slug?: string;
  excerpt?: string;
  imageUrl?: string;
  tag?: string;
  isFeatured?: boolean;
  metaTitle?: string;
  metaDescription?: string;
  keywords?: string;
  createdAt?: string;
  authorId?: string | null;
  category?: string;
  tags?: string[];
  faqs?: { question: string; answer: string }[];
  keyTakeaways?: string[];
  relatedSlugs?: string[];
  tocOverrides?: TocOverride[];
  content?: string;
  status?: 'draft' | 'publish';
}

function isEditorBlogPayload(value: unknown): value is EditorBlogPayload {
  return typeof value === 'object' && value !== null;
}

// ── Content stats helper ──────────────────────────
function getContentStats(html: string) {
  // Strip all HTML tags and decode common entities
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  // Filter out empty tokens from split
  const wordList = text ? text.split(' ').filter((w) => w.length > 0) : [];
  const words = wordList.length;
  const readingTime = words > 0 ? Math.max(1, Math.ceil(words / 238)) : 0;
  return { words, readingTime };
}

function deleteTableRowOrWholeTableAtSelection(
  quill: any,
  range: { index: number; length: number } | null,
  context: { offset: number; suffix: string } | null,
  direction: 'backspace' | 'delete',
) {
  if (!quill || !range || range.length > 0) return false;

  const tableModule = quill.getModule?.('table');
  if (!tableModule || typeof tableModule.getTable !== 'function') return false;

  const [table, row, cell] = tableModule.getTable(range);
  if (!table || !row || !cell) return false;

  const atStartOfCell = (context?.offset ?? 0) === 0;
  const atEndOfCell = (context?.suffix ?? '') === '';
  const isDeleteIntent =
    (direction === 'backspace' && atStartOfCell) || (direction === 'delete' && atEndOfCell);
  if (!isDeleteIntent) return false;

  const rowCount =
    typeof table.rows === 'function'
      ? table.rows().length
      : (table.domNode?.querySelectorAll?.('tr')?.length ?? 0);

  if (rowCount <= 1 && typeof tableModule.deleteTable === 'function') {
    tableModule.deleteTable();
    return true;
  }

  if (typeof tableModule.deleteRow === 'function') {
    tableModule.deleteRow();
    return true;
  }

  return false;
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Failed to compress image'));
          return;
        }
        resolve(blob);
      },
      type,
      quality,
    );
  });
}

async function compressImageForUpload(file: File) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Only image uploads are allowed');
  }

  if (!shouldCompressOnClient(file)) {
    return file;
  }

  const dataUrl = await fileToDataUrl(file);
  const img = new Image();

  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to process image'));
    img.src = dataUrl;
  });

  let width = img.width;
  let height = img.height;
  const longestEdge = Math.max(width, height);

  if (longestEdge > CLIENT_UPLOAD_MAX_DIMENSION) {
    const scale = CLIENT_UPLOAD_MAX_DIMENSION / longestEdge;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to initialize image compression');
  }

  context.drawImage(img, 0, 0, width, height);

  const outputType = CLIENT_UPLOAD_OUTPUT_TYPE;

  let quality = 0.82;
  let blob = await canvasToBlob(canvas, outputType, quality);

  while (blob.size > CLIENT_UPLOAD_TARGET_BYTES && quality > CLIENT_UPLOAD_MIN_QUALITY) {
    quality -= 0.08;
    blob = await canvasToBlob(canvas, outputType, quality);
  }

  if (blob.size > CLIENT_UPLOAD_TARGET_BYTES) {
    throw new Error('Image is still too large after compression. Please use a smaller image.');
  }

  return compressedFileFrom(blob, outputType, file.name);
}

async function uploadImageFile(file: File, siteId: string | undefined) {
  if (!siteId) throw new Error('Choose a site before uploading an image');
  const uploadFile = await compressImageForUpload(file);
  return uploadImageDirect(uploadFile, siteId);
}

// ── Inline insert toolbar ─────────────────────────
function InsertToolbar({
  onInsertImage,
  onInsertDivider,
  onInsertEmbed,
  onInsertTable,
  onInsertCode,
  onInsertGraphic,
}: {
  onInsertImage: () => void;
  onInsertDivider: () => void;
  onInsertEmbed: () => void;
  onInsertTable: () => void;
  onInsertCode: (lang: string) => void;
  onInsertGraphic: () => void;
}) {
  const items = [
    {
      label: 'Image',
      title: 'Insert image at cursor',
      onClick: onInsertImage,
      icon: (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      ),
    },
    {
      label: 'Divider',
      title: 'Insert horizontal rule',
      onClick: onInsertDivider,
      icon: (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <line x1="3" y1="12" x2="21" y2="12" />
        </svg>
      ),
    },
    {
      label: 'Video',
      title: 'Embed YouTube / Vimeo',
      onClick: onInsertEmbed,
      icon: (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
      ),
    },
    {
      label: 'Table',
      title: 'Insert table at cursor',
      onClick: onInsertTable,
      icon: (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="4" width="18" height="16" rx="1.5" />
          <line x1="3" y1="10" x2="21" y2="10" />
          <line x1="9" y1="4" x2="9" y2="20" />
          <line x1="15" y1="4" x2="15" y2="20" />
        </svg>
      ),
    },
    {
      label: 'Graphic',
      title: 'Insert a graphic (stat cards, callout, comparison)',
      onClick: onInsertGraphic,
      icon: (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="12" width="4" height="8" rx="1" />
          <rect x="10" y="7" width="4" height="13" rx="1" />
          <rect x="17" y="3" width="4" height="17" rx="1" />
        </svg>
      ),
    },
  ];

  return (
    <div className="flex items-center gap-1 mb-4">
      <span className="text-[11px] text-gray-300 mr-1" style={{ fontWeight: 500 }}>
        Insert:
      </span>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={item.onClick}
          title={item.title}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] hover:border-[#FF751F] hover:text-[#FF751F] hover:bg-orange-50/40 transition-colors"
          style={{
            borderColor: 'rgba(0,0,0,0.08)',
            color: '#888',
            fontWeight: 500,
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
      <CodeLanguagePicker onPick={onInsertCode} />
    </div>
  );
}

// ── Keyboard shortcuts panel ──────────────────────
function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    { keys: 'Ctrl+B', action: 'Bold' },
    { keys: 'Ctrl+I', action: 'Italic' },
    { keys: 'Ctrl+U', action: 'Underline' },
    { keys: 'Ctrl+K', action: 'Insert link' },
    { keys: 'Ctrl+Shift+1', action: 'Heading 1' },
    { keys: 'Ctrl+Shift+2', action: 'Heading 2' },
    { keys: 'Ctrl+Shift+7', action: 'Ordered list' },
    { keys: 'Ctrl+Shift+8', action: 'Bullet list' },
    { keys: 'Ctrl+Shift+9', action: 'Blockquote' },
  ];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/20 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl border"
        style={{ borderColor: 'rgba(0,0,0,0.06)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base" style={{ fontWeight: 600, color: '#1a1a1a' }}>
            Keyboard shortcuts
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 transition-colors">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex flex-col gap-2.5">
          {shortcuts.map((s) => (
            <div key={s.keys} className="flex items-center justify-between">
              <span className="text-sm text-gray-600">{s.action}</span>
              <kbd
                className="text-[11px] px-2 py-1 rounded-md bg-gray-100 text-gray-500 border border-gray-200"
                style={{
                  fontWeight: 500,
                  fontFamily: 'var(--font-mono), monospace',
                }}
              >
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main editor form ────────────────────────────
function EditorForm() {
  const site = useSite();
  const router = useRouter();
  const searchParams = useSearchParams();
  const editSlug = searchParams.get('slug');

  const [loadingData, setLoadingData] = useState(!!editSlug);
  const [originalSlug, setOriginalSlug] = useState<string | null>(null);
  const [currentStatus, setCurrentStatus] = useState<'draft' | 'publish' | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSeoOpen, setIsSeoOpen] = useState(false);
  const [isStructuredOpen, setIsStructuredOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showInsertMenu, setShowInsertMenu] = useState(false);
  const [graphicModal, setGraphicModal] = useState<{
    config: GraphicConfig | null;
    editIndex: number | null;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  // Tag Menu State
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [customTag, setCustomTag] = useState('');
  const predefinedTags = ['Insights', 'Product', 'Company', 'Engineering', 'News', 'Tutorials'];

  // Image Upload State
  const [imageType, setImageType] = useState<'url' | 'upload'>('url');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inlineImageRef = useRef<HTMLInputElement>(null);
  const quillRef = useRef<any>(null);

  const [formData, setFormData] = useState({
    title: '',
    slug: '',
    excerpt: '',
    imageUrl: '',
    tag: 'Insights',
    isFeatured: false,
    metaTitle: '',
    metaDescription: '',
    keywords: '',
    createdAt: new Date().toISOString().substring(0, 10),
    authorId: null as string | null,
    category: 'Insights',
    tags: [] as string[],
    faqs: [] as { question: string; answer: string }[],
    keyTakeaways: [] as string[],
    relatedSlugs: [] as string[],
    tocOverrides: [] as TocOverride[],
  });

  const [content, setContent] = useState('');
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const excerptRef = useRef<HTMLTextAreaElement>(null);
  const initialSnapshotRef = useRef<string>('');

  const hydrateBlog = useCallback((data: EditorBlogPayload) => {
    const hydrated = {
      title: data.title || '',
      slug: data.slug || '',
      excerpt: data.excerpt || '',
      imageUrl: data.imageUrl || '',
      tag: data.tag || 'Insights',
      isFeatured: !!data.isFeatured,
      metaTitle: data.metaTitle || '',
      metaDescription: data.metaDescription || '',
      keywords: data.keywords || '',
      createdAt: data.createdAt
        ? new Date(data.createdAt).toISOString().substring(0, 10)
        : new Date().toISOString().substring(0, 10),
      authorId: data.authorId || null,
      category: data.category || data.tag || 'Insights',
      tags: Array.isArray(data.tags) && data.tags.length ? data.tags : data.tag ? [data.tag] : [],
      faqs: Array.isArray(data.faqs) ? data.faqs : [],
      keyTakeaways: Array.isArray(data.keyTakeaways) ? data.keyTakeaways : [],
      relatedSlugs: Array.isArray(data.relatedSlugs) ? data.relatedSlugs : [],
      tocOverrides: Array.isArray(data.tocOverrides) ? data.tocOverrides : [],
    };
    const restoredContent = data.content || '';
    setFormData(hydrated);
    setContent(restoredContent);
    setCurrentStatus(data.status === 'publish' ? 'publish' : 'draft');
    setSlugManuallyEdited(true);
    initialSnapshotRef.current = JSON.stringify({ ...hydrated, content: restoredContent });
  }, []);

  // Fetch existing blog if editSlug
  useEffect(() => {
    if (!editSlug) return;
    setOriginalSlug(editSlug);
    setLoadingData(true);
    const controller = new AbortController();
    fetch(`/api/admin/blogs/${encodeURIComponent(editSlug)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((res) => res.json() as Promise<unknown>)
      .then((data) => {
        if (isEditorBlogPayload(data) && !('error' in data)) hydrateBlog(data);
      })
      .catch((fetchError: unknown) => {
        if ((fetchError as Error).name !== 'AbortError') setError('Unable to load the blog.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingData(false);
      });
    return () => controller.abort();
  }, [editSlug, hydrateBlog, site?.id]);

  useEffect(() => {
    if (!editSlug) {
      initialSnapshotRef.current = JSON.stringify({
        ...formData,
        content: '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSlug]);

  const stats = useMemo(() => getContentStats(content), [content]);
  const hasUnsavedChanges = JSON.stringify({ ...formData, content }) !== initialSnapshotRef.current;

  // ── Auto-resize textareas ─────────────────────
  useEffect(() => {
    if (titleRef.current) {
      titleRef.current.style.height = 'auto';
      titleRef.current.style.height = titleRef.current.scrollHeight + 'px';
    }
  }, [formData.title]);

  useEffect(() => {
    if (excerptRef.current) {
      excerptRef.current.style.height = 'auto';
      excerptRef.current.style.height = excerptRef.current.scrollHeight + 'px';
    }
  }, [formData.excerpt]);

  // ── Handlers ──────────────────────────────────
  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => {
    const { name, value } = e.target;
    if (name === 'slug') {
      setSlugManuallyEdited(true);
    }
    setFormData({ ...formData, [name]: value });
  };

  const handleTitleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const slug = slugify(val);
    setFormData({
      ...formData,
      title: val,
      ...(!slugManuallyEdited ? { slug } : {}),
    });
  };

  // Title → Excerpt with Tab key
  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      excerptRef.current?.focus();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      excerptRef.current?.focus();
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        setLoading(true);
        setError(null);
        const imageUrl = await uploadImageFile(file, site?.id);
        setFormData({ ...formData, imageUrl });
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
        e.target.value = '';
      }
    }
  };

  // ── Drag & drop for cover image ───────────────
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        try {
          setLoading(true);
          setError(null);
          const imageUrl = await uploadImageFile(file, site?.id);
          setFormData((prev) => ({ ...prev, imageUrl }));
        } catch (err: any) {
          setError(err.message);
        } finally {
          setLoading(false);
        }
      }
    },
    [site?.id],
  );

  // ── Insert actions — use Quill API at cursor ───
  const handleInsertImage = () => {
    inlineImageRef.current?.click();
  };

  const handleInlineImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setLoading(true);
      setError(null);
      const imageUrl = await uploadImageFile(file, site?.id);

      const quill = (quillRef.current as any)?.getEditor?.();
      if (quill) {
        const range = quill.getSelection(true);
        const index = range ? range.index : quill.getLength();
        quill.insertEmbed(index, 'image', imageUrl);
        quill.setSelection(index + 1);
      } else {
        // Fallback: append HTML directly if Quill ref not ready
        setContent(
          (prev) =>
            prev + `<p><img src="${imageUrl}" alt="Inline image" style="max-width:100%" /></p>`,
        );
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
      // Reset so the same file can be re-selected
      if (inlineImageRef.current) inlineImageRef.current.value = '';
    }
  };

  const handleInsertDivider = () => {
    const quill = (quillRef.current as any)?.getEditor?.();
    if (quill) {
      const range = quill.getSelection(true);
      const index = range ? range.index : quill.getLength() - 1;
      // insertEmbed uses the registered DividerBlot which maps to a real <hr> element
      quill.insertEmbed(index, 'divider', true, 'user');
      quill.setSelection(index + 1, 0, 'user');
    } else {
      setContent((prev) => prev + '<hr data-divider="true" />');
    }
  };

  const handleInsertEmbed = () => {
    const url = prompt('Paste a YouTube or Vimeo URL:');
    if (!url) return;
    let embedUrl = url;
    const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
    if (ytMatch) embedUrl = `https://www.youtube.com/embed/${ytMatch[1]}`;
    const quill = (quillRef.current as any)?.getEditor?.();
    if (quill) {
      const range = quill.getSelection(true);
      const index = range ? range.index : quill.getLength();
      quill.insertEmbed(index, 'video', embedUrl);
      quill.setSelection(index + 1);
    } else {
      setContent(
        (prev) =>
          prev + `<p><iframe src="${embedUrl}" frameborder="0" allowfullscreen></iframe></p>`,
      );
    }
  };

  const handleInsertTable = () => {
    const rowsInput = prompt('Number of rows?', '3');
    if (!rowsInput) return;
    const colsInput = prompt('Number of columns?', '3');
    if (!colsInput) return;

    const parsedRows = Number.parseInt(rowsInput, 10);
    const parsedCols = Number.parseInt(colsInput, 10);
    // Invalid values fall back to sensible defaults, then clamp to supported bounds.
    const rows = Math.min(10, Math.max(1, Number.isNaN(parsedRows) ? 3 : parsedRows));
    const cols = Math.min(8, Math.max(1, Number.isNaN(parsedCols) ? 3 : parsedCols));

    const quill = (quillRef.current as any)?.getEditor?.();

    const tableModule = quill?.getModule?.('table');
    if (!tableModule || typeof tableModule.insertTable !== 'function') {
      setError('Table support is unavailable in this editor configuration.');
      return;
    }
    tableModule.insertTable(rows, cols);
  };

  const handleInsertCode = (lang: string) => {
    const quill = (quillRef.current as any)?.getEditor?.();
    if (!quill) return;
    const range = quill.getSelection(true);
    let index = range ? range.index : quill.getLength();
    const lineInfo = quill.getLine(index); // [lineBlot, offsetInLine]
    const offset = lineInfo ? lineInfo[1] : 0;
    if (offset !== 0) {
      // mid-line → break to a new line first
      quill.insertText(index, '\n', 'user');
      index += 1;
    }
    quill.formatLine(index, 1, 'code-block', lang, 'user');
    quill.setSelection(index, 0, 'user');
  };

  // ── Graphics (stat cards / callout / comparison) ──
  const handleInsertGraphic = () => setGraphicModal({ config: null, editIndex: null });

  const handleSaveGraphic = (config: GraphicConfig) => {
    const quill = (quillRef.current as any)?.getEditor?.();
    if (quill) {
      if (graphicModal?.editIndex != null) {
        // Editing an existing graphic — replace the embed in place
        quill.deleteText(graphicModal.editIndex, 1, 'user');
        quill.insertEmbed(graphicModal.editIndex, 'graphic', config, 'user');
        quill.setSelection(graphicModal.editIndex + 1, 0, 'user');
      } else {
        const range = quill.getSelection(true);
        const index = range ? range.index : quill.getLength();
        quill.insertEmbed(index, 'graphic', config, 'user');
        quill.setSelection(index + 1, 0, 'user');
      }
    }
    setGraphicModal(null);
  };

  // Click an inserted graphic to edit it (the blot is contenteditable=false)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.('.blog-graphic') as HTMLElement | null;
      if (!el || !el.closest('.editor-canvas')) return;
      const quill = (quillRef.current as any)?.getEditor?.();
      if (!quill) return;
      const blot = (quill.constructor as any)?.find?.(el);
      if (!blot) return;
      const config = decodeConfig(el.getAttribute('data-config') || '');
      if (config) setGraphicModal({ config, editIndex: quill.getIndex(blot) });
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // ── Submit ────────────────────────────────────
  const handleSubmit = async (action: 'draft' | 'publish') => {
    if (!formData.title) {
      setError('Title is required.');
      return;
    }
    if (!formData.slug) {
      setError('Slug is required.');
      return;
    }
    if (!content.trim()) {
      setError('Content is required.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const isEdit = !!originalSlug;
      const endpoint = isEdit ? `/api/admin/blogs/${originalSlug}` : '/api/admin/blogs';
      const method = isEdit ? 'PUT' : 'POST';

      const cleanFaqs = formData.faqs.filter((f) => f.question.trim() && f.answer.trim());
      const cleanTakeaways = formData.keyTakeaways.map((t) => t.trim()).filter(Boolean);

      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          // Tags are the source of truth; keep the legacy single `tag` (used for
          // the public badge / list) and `category` (used for related-by-category)
          // in sync with the first tag for back-compat.
          tags: formData.tags,
          tag: formData.tags[0] || 'Insights',
          category: formData.tags[0] || 'Insights',
          content,
          status: action,
          faqs: cleanFaqs,
          keyTakeaways: cleanTakeaways,
          relatedSlugs: formData.relatedSlugs,
          tocOverrides: formData.tocOverrides,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(
          data.details?.fieldErrors?.authorId?.[0] || data.error || 'Failed to save blog post.',
        );
        return;
      }
      initialSnapshotRef.current = JSON.stringify({ ...formData, content });
      router.push('/admin/dashboard/blogs');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Quill config — bubble theme (floating toolbar) ─
  const modules = useMemo(
    () => ({
      table: true,
      keyboard: {
        bindings: {
          'table backspace': {
            key: 'Backspace',
            format: ['table'],
            collapsed: true,
            offset: 0,
            handler(
              this: { quill: any },
              range: { index: number; length: number },
              context: { offset: number; suffix: string },
            ) {
              return !deleteTableRowOrWholeTableAtSelection(
                this.quill,
                range,
                context,
                'backspace',
              );
            },
          },
          'table delete': {
            key: 'Delete',
            format: ['table'],
            collapsed: true,
            suffix: /^$/,
            handler(
              this: { quill: any },
              range: { index: number; length: number },
              context: { offset: number; suffix: string },
            ) {
              return !deleteTableRowOrWholeTableAtSelection(this.quill, range, context, 'delete');
            },
          },
        },
      },
      toolbar: [
        [{ size: ['small', false, 'large', 'huge'] }],
        [{ header: [1, 2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        ['blockquote', 'code-block'],
        ['link'],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['clean'],
      ],
    }),
    [],
  );

  const formats = [
    'size',
    'header',
    'bold',
    'italic',
    'underline',
    'strike',
    'blockquote',
    'code-block',
    'link',
    'list',
    'image',
    'video',
    'table',
    'table-row',
    'divider', // custom blot for <hr> divider lines
    'graphic', // custom blot for inline graphics (stat cards / callout / comparison)
    'align',
  ];

  return (
    <div className="min-h-screen bg-white text-[#1a1a1a]">
      {/* Hidden file inputs */}
      <input
        type="file"
        ref={inlineImageRef}
        onChange={handleInlineImageUpload}
        className="hidden"
        accept="image/*"
      />

      {/* ── Sticky top bar ──────────────────────── */}
      <div
        className="sticky top-0 z-50 bg-white/95 backdrop-blur-lg px-6 py-3.5 flex items-center justify-between"
        style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}
      >
        <div className="flex items-center gap-4">
          <Link
            href="/admin/dashboard/blogs"
            className="text-gray-400 hover:text-gray-800 transition-colors"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </Link>

          {/* Loading / Save status */}
          <div className="flex items-center gap-2">
            {loadingData && (
              <span
                className="text-[11px] text-gray-400 flex items-center gap-1.5"
                style={{ fontWeight: 500 }}
              >
                <span className="w-1.5 h-1.5 rounded-full border-2 border-gray-400 border-t-transparent animate-spin" />
                Loading editor...
              </span>
            )}
            {!loadingData && hasUnsavedChanges && (
              <span
                className="text-[11px] text-amber-500 flex items-center gap-1.5"
                style={{ fontWeight: 500 }}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                Unsaved changes
              </span>
            )}
            {!loadingData && !hasUnsavedChanges && (
              <span
                className="text-[11px] text-gray-400 flex items-center gap-1.5"
                style={{ fontWeight: 500 }}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                All changes saved
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Stats — always visible */}
          <div
            className="flex items-center gap-3 mr-3 text-[11px] text-gray-400"
            style={{ fontWeight: 500 }}
          >
            <span>
              {stats.words} {stats.words === 1 ? 'word' : 'words'}
            </span>
            {stats.words > 0 && (
              <>
                <span className="w-px h-3 bg-gray-200" />
                <span>{stats.readingTime} min read</span>
              </>
            )}
          </div>

          {/* Shortcuts button */}
          <button
            type="button"
            onClick={() => setShowShortcuts(true)}
            className="w-8 h-8 rounded-lg border flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors"
            style={{ borderColor: 'rgba(0,0,0,0.08)' }}
            title="Keyboard shortcuts"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="6" width="20" height="12" rx="2" />
              <line x1="6" y1="10" x2="6" y2="10" />
              <line x1="10" y1="10" x2="10" y2="10" />
              <line x1="14" y1="10" x2="14" y2="10" />
              <line x1="18" y1="10" x2="18" y2="10" />
              <line x1="8" y1="14" x2="16" y2="14" />
            </svg>
          </button>

          <VersionHistory
            slug={originalSlug}
            siteId={site?.id}
            isPublished={currentStatus === 'publish'}
            hasUnsavedChanges={hasUnsavedChanges}
            onRestored={(blog) => {
              if (isEditorBlogPayload(blog)) hydrateBlog(blog);
            }}
          />

          <button
            type="button"
            onClick={() => handleSubmit('draft')}
            disabled={loading}
            className="px-4 py-2 text-[13px] text-gray-600 hover:bg-gray-50 border rounded-full transition-colors disabled:opacity-50"
            style={{ fontWeight: 500, borderColor: 'rgba(0,0,0,0.12)' }}
          >
            Save draft
          </button>
          <button
            type="button"
            onClick={() => handleSubmit('publish')}
            disabled={loading}
            className="px-5 py-2 text-[13px] text-white rounded-full shadow-sm transition-all disabled:opacity-50"
            style={{
              fontWeight: 600,
              background: 'linear-gradient(135deg, #1a8917, #2ba52b)',
              boxShadow: '0 2px 8px rgba(26,137,23,0.3)',
            }}
          >
            {loading ? 'Publishing...' : 'Publish'}
          </button>
        </div>
      </div>

      {error && (
        <div className="max-w-[720px] mx-auto mt-6 px-6">
          <div className="p-4 text-sm text-red-700 bg-red-50 rounded-xl border border-red-200">
            {error}
          </div>
        </div>
      )}

      {/* ── Main editor canvas ─────────────────── */}
      <main className="max-w-[720px] mx-auto px-6 pt-12 pb-32">
        {/* ── Cover image with drag & drop ─────── */}
        <div className="mb-10 group">
          {formData.imageUrl ? (
            <div className="relative w-full aspect-[16/9] bg-gray-50 rounded-xl overflow-hidden group-hover:ring-2 ring-black/5 transition-all">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={formData.imageUrl} alt="Cover" className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              {/* Remove button — always visible */}
              <button
                type="button"
                onClick={() => setFormData({ ...formData, imageUrl: '' })}
                className="absolute top-3 right-3 bg-white text-gray-600 p-1.5 rounded-lg hover:bg-red-50 hover:text-red-500 transition-colors flex items-center gap-1 text-xs shadow-sm border"
                style={{ fontWeight: 500, borderColor: 'rgba(0,0,0,0.08)' }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                Remove cover
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="absolute bottom-3 right-3 bg-white/90 backdrop-blur text-gray-700 px-3 py-1.5 rounded-lg text-xs hover:bg-white transition-colors opacity-0 group-hover:opacity-100 flex items-center gap-1.5"
                style={{ fontWeight: 500 }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                Change
              </button>
            </div>
          ) : (
            <div
              className={`w-full aspect-[16/9] border-2 border-dashed rounded-xl flex flex-col items-center justify-center p-8 text-center transition-all cursor-pointer ${
                isDragging
                  ? 'border-[#FF751F] bg-orange-50/50'
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50/50'
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => !isDragging && fileInputRef.current?.click()}
            >
              <svg
                className="w-7 h-7 text-gray-300 mb-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a1.5 1.5 0 001.5-1.5V5.25a1.5 1.5 0 00-1.5-1.5H3.75a1.5 1.5 0 00-1.5 1.5V19.5a1.5 1.5 0 001.5 1.5z"
                />
              </svg>
              <p className="text-sm text-gray-400 mb-1" style={{ fontWeight: 500 }}>
                {isDragging ? 'Drop image here' : 'Add a cover image'}
              </p>
              <p className="text-[11px] text-gray-300">Drag & drop or click to browse</p>
              <p className="text-[11px] text-gray-300 mt-1">Recommended: 2240×1260px (16:9)</p>

              {/* URL toggle */}
              <div className="flex items-center gap-2 mt-4">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setImageType('url');
                  }}
                  className={`text-[11px] px-2.5 py-1 rounded-full transition-colors ${imageType === 'url' ? 'bg-gray-200 text-gray-700' : 'text-gray-400 hover:text-gray-600'}`}
                  style={{ fontWeight: 500 }}
                >
                  Paste URL
                </button>
              </div>

              {imageType === 'url' && (
                <input
                  type="text"
                  name="imageUrl"
                  value={formData.imageUrl}
                  onChange={handleChange}
                  onClick={(e) => e.stopPropagation()}
                  className="mt-3 px-4 py-2 w-full max-w-sm rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-orange-200 text-center"
                  style={{ borderColor: 'rgba(0,0,0,0.1)' }}
                  placeholder="https://example.com/image.jpg"
                />
              )}
            </div>
          )}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImageUpload}
            className="hidden"
            accept="image/*"
          />
        </div>

        {/* ── Tags (multi-select) ────────────────── */}
        <div className="mb-6 flex flex-wrap items-center gap-2 relative">
          {formData.tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-orange-600 bg-orange-50 border border-orange-100 rounded-full"
            >
              {t}
              <button
                type="button"
                onClick={() =>
                  setFormData({ ...formData, tags: formData.tags.filter((x) => x !== t) })
                }
                className="text-orange-400 hover:text-orange-700 leading-none text-sm"
                aria-label={`Remove tag ${t}`}
              >
                ×
              </button>
            </span>
          ))}

          <button
            type="button"
            onClick={() => setShowTagMenu(!showTagMenu)}
            className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-orange-600 bg-orange-50 border border-orange-100 rounded-full cursor-pointer hover:bg-orange-100 transition-colors focus:outline-none focus:ring-2 focus:ring-orange-200 flex items-center gap-2 relative z-[5]"
            style={{ fontFamily: 'inherit' }}
          >
            {formData.tags.length ? 'Add Tag' : 'Add Tags'}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
          </button>

          {showTagMenu && (
            <div className="absolute top-full left-0 mt-2 w-56 bg-white border border-gray-100 shadow-xl rounded-xl z-[60] p-2 flex flex-col gap-1">
              {predefinedTags.map((t) => {
                const active = formData.tags.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() =>
                      setFormData({
                        ...formData,
                        tags: active ? formData.tags.filter((x) => x !== t) : [...formData.tags, t],
                      })
                    }
                    className={`flex items-center justify-between text-left px-3 py-2 text-xs rounded-lg transition-colors ${active ? 'bg-orange-50 text-orange-600 font-medium' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}`}
                  >
                    {t}
                    {active && <span className="text-orange-500">✓</span>}
                  </button>
                );
              })}
              <div className="h-px bg-gray-100 my-1"></div>
              <div className="flex items-center gap-2 px-1 py-1">
                <input
                  type="text"
                  placeholder="Custom tag..."
                  value={customTag}
                  onChange={(e) => setCustomTag(e.target.value)}
                  className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:border-orange-300 placeholder-gray-400"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const v = customTag.trim();
                      if (v && !formData.tags.includes(v)) {
                        setFormData({ ...formData, tags: [...formData.tags, v] });
                      }
                      setCustomTag('');
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const v = customTag.trim();
                    if (v && !formData.tags.includes(v)) {
                      setFormData({ ...formData, tags: [...formData.tags, v] });
                    }
                    setCustomTag('');
                  }}
                  className="bg-orange-500 text-white rounded-md p-1.5 hover:bg-orange-600 transition-colors flex-shrink-0"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Title & Subtitle ─────────────────── */}
        <div className="mb-2">
          <textarea
            ref={titleRef}
            name="title"
            value={formData.title}
            onChange={handleTitleChange}
            onKeyDown={handleTitleKeyDown}
            placeholder="Title"
            className="w-full text-[40px] text-[#242424] placeholder-[#c8c8c8] border-none outline-none resize-none overflow-hidden leading-[1.15] mb-3 block bg-transparent"
            style={{ fontWeight: 600, letterSpacing: '-0.02em' }}
            rows={1}
          />

          <textarea
            ref={excerptRef}
            name="excerpt"
            value={formData.excerpt}
            onChange={handleChange}
            placeholder="Tell readers what your story is about..."
            className="w-full text-xl text-[#757575] placeholder-[#c8c8c8] border-none outline-none resize-none overflow-hidden leading-relaxed mb-6 block bg-transparent"
            style={{ fontWeight: 400 }}
            rows={1}
          />
        </div>

        {/* ── Separator ────────────────────────── */}
        <div className="h-px bg-gray-100 mb-8" />

        {/* ── Inline insert toolbar + Bubble editor ─ */}
        <div className="relative">
          {/* Always-visible inline insert toolbar */}
          <InsertToolbar
            onInsertImage={handleInsertImage}
            onInsertDivider={handleInsertDivider}
            onInsertEmbed={handleInsertEmbed}
            onInsertTable={handleInsertTable}
            onInsertCode={handleInsertCode}
            onInsertGraphic={handleInsertGraphic}
          />

          {/* Quill with bubble theme — floating toolbar on selection */}
          {/* Tip: click any inserted image to select it, then press Delete/Backspace to remove it */}
          <div
            className="editor-canvas
            [&_.ql-container]:border-0
            [&_.ql-editor.ql-blank::before]:text-[#c8c8c8] [&_.ql-editor.ql-blank::before]:text-lg [&_.ql-editor.ql-blank::before]:font-normal [&_.ql-editor.ql-blank::before]:left-0 [&_.ql-editor.ql-blank::before]:not-italic
            [&_.ql-editor]:min-h-[400px] [&_.ql-editor]:px-0
            [&_.ql-editor_.ql-size-small]:text-[0.9em]
            [&_.ql-editor_.ql-size-large]:text-[1.2em]
            [&_.ql-editor_.ql-size-huge]:text-[1.45em]
            [&_.ql-bubble_.ql-tooltip]:bg-[#1a1a1a] [&_.ql-bubble_.ql-tooltip]:rounded-lg [&_.ql-bubble_.ql-tooltip]:shadow-xl
          "
          >
            <ReactQuill
              // Keep browser-escaped attributes; Quill 2 semantic video export is unsafe.
              useSemanticHTML={false}
              {...({ ref: quillRef } as any)}
              theme="bubble"
              value={content}
              onChange={setContent}
              modules={modules}
              formats={formats}
              placeholder="Write your story..."
            />
          </div>
        </div>

        {/* ── Author ──────────────────────────── */}
        <div className="mt-14 pt-8 space-y-5" style={{ borderTop: '1px solid rgba(0,0,0,0.06)' }}>
          <AuthorPicker
            value={formData.authorId}
            onChange={(id) => setFormData({ ...formData, authorId: id })}
          />
        </div>

        {/* ── Structured content ──────────────── */}
        <div className="mt-10 pt-8" style={{ borderTop: '1px solid rgba(0,0,0,0.06)' }}>
          <button
            type="button"
            onClick={() => setIsStructuredOpen(!isStructuredOpen)}
            className="flex items-center justify-between w-full text-left py-2 cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-gray-400"
              >
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
                <rect x="9" y="3" width="6" height="4" rx="1" />
                <line x1="9" y1="12" x2="15" y2="12" />
                <line x1="9" y1="16" x2="13" y2="16" />
              </svg>
              <span className="text-sm" style={{ fontWeight: 600, color: '#555' }}>
                Structured Content
              </span>
            </div>
            <svg
              className={`w-4 h-4 text-gray-400 transform transition-transform ${isStructuredOpen ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>

          {isStructuredOpen && (
            <div className="mt-4 space-y-7">
              <FaqRepeater
                value={formData.faqs}
                onChange={(v) => setFormData({ ...formData, faqs: v })}
              />
              <TakeawaysRepeater
                value={formData.keyTakeaways}
                onChange={(v) => setFormData({ ...formData, keyTakeaways: v })}
              />
              <RelatedPicker
                value={formData.relatedSlugs}
                currentSlug={formData.slug}
                onChange={(v) => setFormData({ ...formData, relatedSlugs: v })}
              />
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-[12px] uppercase tracking-wider text-gray-400"
                  style={{ fontWeight: 600 }}
                >
                  Table of Contents
                </label>
                <TocEditor
                  content={content}
                  value={formData.tocOverrides}
                  onChange={(v) => setFormData({ ...formData, tocOverrides: v })}
                />
              </div>
            </div>
          )}
        </div>

        {/* ── SEO & Metadata ───────────────────── */}
        <div className="mt-10 pt-8" style={{ borderTop: '1px solid rgba(0,0,0,0.06)' }}>
          <button
            type="button"
            onClick={() => setIsSeoOpen(!isSeoOpen)}
            className="flex items-center justify-between w-full text-left py-2 cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-gray-400"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <span className="text-sm" style={{ fontWeight: 600, color: '#555' }}>
                SEO & Metadata
              </span>
            </div>
            <svg
              className={`w-4 h-4 text-gray-400 transform transition-transform ${isSeoOpen ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>

          {isSeoOpen && (
            <div className="mt-4 space-y-5">
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-[12px] uppercase tracking-wider text-gray-400"
                  style={{ fontWeight: 600 }}
                >
                  URL Slug
                </label>
                <div className="flex items-center gap-1 text-sm text-gray-400">
                  <span>{site?.publicPaths.blogs ?? '/blogs'}/</span>
                  <input
                    type="text"
                    name="slug"
                    value={formData.slug}
                    onChange={handleChange}
                    className="flex-1 px-3 py-2 rounded-lg border bg-gray-50/50 focus:outline-none focus:ring-2 focus:ring-gray-200 text-[#1a1a1a] text-sm"
                    style={{ borderColor: 'rgba(0,0,0,0.08)' }}
                    placeholder="my-blog-post"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="flex flex-col gap-1.5">
                  <label
                    className="text-[12px] uppercase tracking-wider text-gray-400"
                    style={{ fontWeight: 600 }}
                  >
                    Meta Title
                  </label>
                  <input
                    type="text"
                    name="metaTitle"
                    value={formData.metaTitle}
                    onChange={handleChange}
                    className="px-3 py-2 rounded-lg border bg-gray-50/50 focus:outline-none focus:ring-2 focus:ring-gray-200 text-sm"
                    style={{ borderColor: 'rgba(0,0,0,0.08)' }}
                    placeholder="Title for search engines"
                  />
                  <span className="text-[11px] text-gray-300">
                    {formData.metaTitle.length}/60 characters
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label
                    className="text-[12px] uppercase tracking-wider text-gray-400"
                    style={{ fontWeight: 600 }}
                  >
                    Publish Date
                  </label>
                  <input
                    type="date"
                    name="createdAt"
                    value={formData.createdAt}
                    onChange={handleChange}
                    className="px-3 py-2 rounded-lg border bg-gray-50/50 focus:outline-none focus:ring-2 focus:ring-gray-200 text-sm"
                    style={{ borderColor: 'rgba(0,0,0,0.08)' }}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  className="text-[12px] uppercase tracking-wider text-gray-400"
                  style={{ fontWeight: 600 }}
                >
                  Meta Description
                </label>
                <textarea
                  name="metaDescription"
                  value={formData.metaDescription}
                  onChange={handleChange}
                  className="px-3 py-3 rounded-lg border bg-gray-50/50 focus:outline-none focus:ring-2 focus:ring-gray-200 min-h-[72px] text-sm"
                  style={{ borderColor: 'rgba(0,0,0,0.08)' }}
                  placeholder="A compelling summary for search results..."
                />
                <span className="text-[11px] text-gray-300">
                  {formData.metaDescription.length}/160 characters
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  className="text-[12px] uppercase tracking-wider text-gray-400"
                  style={{ fontWeight: 600 }}
                >
                  Keywords
                </label>
                <input
                  type="text"
                  name="keywords"
                  value={formData.keywords}
                  onChange={handleChange}
                  className="px-3 py-2 rounded-lg border bg-gray-50/50 focus:outline-none focus:ring-2 focus:ring-gray-200 text-sm"
                  style={{ borderColor: 'rgba(0,0,0,0.08)' }}
                  placeholder="ai, analysis, visibility"
                />
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ── Keyboard shortcuts modal ───────────── */}
      {showShortcuts && <ShortcutsPanel onClose={() => setShowShortcuts(false)} />}
      {graphicModal && (
        <GraphicEditorModal
          initial={graphicModal.config}
          onSave={handleSaveGraphic}
          onClose={() => setGraphicModal(null)}
        />
      )}
    </div>
  );
}

// ── Expose wrapped component ──────────────────────
export default function NewBlogPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-white" />}>
      <EditorForm />
    </Suspense>
  );
}
