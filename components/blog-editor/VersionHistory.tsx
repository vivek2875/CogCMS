'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import type { BlogRevisionSnapshot } from '@/models/BlogRevision';

type RevisionAction = 'created' | 'updated' | 'restored';
type RevisionActor = { name?: string } | string | null;

interface RevisionSummary {
  _id: string;
  action: RevisionAction;
  createdAt: string;
  createdBy: RevisionActor;
  restoredFromRevisionId: string | null;
}

interface RevisionDetail extends RevisionSummary {
  snapshot: BlogRevisionSnapshot;
}

function actorName(actor: RevisionActor): string {
  if (!actor) return 'Unknown editor';
  return typeof actor === 'string' ? 'Unknown editor' : actor.name || 'Unknown editor';
}

function actionLabel(action: RevisionAction): string {
  return action === 'created' ? 'Created' : action === 'updated' ? 'Updated' : 'Restored';
}

async function responseMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string') return error;
  }
  return 'Unable to load version history.';
}

export default function VersionHistory({
  slug,
  siteId,
  isPublished,
  hasUnsavedChanges,
  onRestored,
}: {
  slug: string | null;
  siteId: string | undefined;
  isPublished: boolean;
  hasUnsavedChanges: boolean;
  onRestored: (blog: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [detail, setDetail] = useState<RevisionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [success, setSuccess] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const detailControllerRef = useRef<AbortController | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const loadRevisions = useCallback(async () => {
    if (!slug) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setLoadError('');
    try {
      const response = await fetch(
        `/api/admin/blogs/${encodeURIComponent(slug)}/revisions?page=${page}&limit=20`,
        {
          cache: 'no-store',
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload: unknown = await response.json();
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('data' in payload) ||
        !Array.isArray((payload as { data: unknown }).data)
      )
        throw new Error('Unable to load version history.');
      setRevisions((payload as { data: RevisionSummary[] }).data);
      setMeta((payload as { meta: typeof meta }).meta);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        setLoadError(error instanceof Error ? error.message : 'Unable to load version history.');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [slug, siteId, page]);

  useEffect(() => {
    if (!open) return;
    setDetail(null);
    setSuccess('');
    void loadRevisions();
    return () => {
      controllerRef.current?.abort();
      detailControllerRef.current?.abort();
    };
  }, [loadRevisions, open]);

  useEffect(() => {
    if (!open) {
      triggerRef.current?.focus();
      return;
    }
    closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setPage(1);
    setDetail(null);
    detailControllerRef.current?.abort();
  }, [slug, siteId]);

  const inspect = async (revisionId: string) => {
    if (!slug) return;
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    setDetailLoading(true);
    setDetailError('');
    setRestoreError('');
    try {
      const response = await fetch(
        `/api/admin/blogs/${encodeURIComponent(slug)}/revisions/${encodeURIComponent(revisionId)}`,
        { cache: 'no-store', signal: controller.signal },
      );
      if (!response.ok) throw new Error(await responseMessage(response));
      if (!controller.signal.aborted) setDetail((await response.json()) as RevisionDetail);
    } catch (error) {
      if ((error as Error).name !== 'AbortError')
        setDetailError(error instanceof Error ? error.message : 'Unable to load this revision.');
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  };

  const restore = async () => {
    if (!slug || !detail) return;
    setRestoring(true);
    setRestoreError('');
    try {
      const response = await fetch(
        `/api/admin/blogs/${encodeURIComponent(slug)}/revisions/${encodeURIComponent(detail._id)}/restore`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      if (!response.ok) throw new Error(await responseMessage(response));
      onRestored(await response.json());
      setConfirming(false);
      setSuccess('Version restored. The previous current version remains in history.');
      await loadRevisions();
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : 'Unable to restore this revision.');
    } finally {
      setRestoring(false);
    }
  };

  if (!slug) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-2 text-[13px] text-gray-600 hover:bg-gray-50 border rounded-full transition-colors"
        style={{ fontWeight: 500, borderColor: 'rgba(0,0,0,0.12)' }}
        aria-haspopup="dialog"
      >
        Version history
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[90] bg-black/30 flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-labelledby="version-history-title"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
          <section className="h-full w-full max-w-xl bg-white shadow-2xl overflow-y-auto p-5 sm:p-7">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="version-history-title" className="text-lg font-semibold text-gray-900">
                  Version history
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  Inspect a saved version before restoring it.
                </p>
              </div>
              <button
                type="button"
                ref={closeRef}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2 text-sm text-gray-600 hover:bg-gray-100"
                aria-label="Close version history"
              >
                Close
              </button>
            </div>

            {success && (
              <p className="mt-5 rounded-md bg-green-50 p-3 text-sm text-green-800" role="status">
                {success}
              </p>
            )}
            {loadError && (
              <div className="mt-5 rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">
                <p>{loadError}</p>
                <button
                  type="button"
                  className="mt-2 underline"
                  onClick={() => void loadRevisions()}
                >
                  Retry
                </button>
              </div>
            )}
            {loading && (
              <p className="mt-6 text-sm text-gray-500" role="status">
                Loading versions…
              </p>
            )}
            {!loading && !loadError && revisions.length === 0 && (
              <p className="mt-6 rounded-md bg-gray-50 p-4 text-sm text-gray-600">
                No versions have been saved for this blog yet.
              </p>
            )}
            <ol className="mt-5 space-y-2" aria-label="Saved blog revisions">
              {revisions.map((revision) => (
                <li key={revision._id} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {actionLabel(revision.action)}
                      </p>
                      <p className="text-xs text-gray-500">
                        {new Date(revision.createdAt).toLocaleString()} ·{' '}
                        {actorName(revision.createdBy)}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="text-sm text-green-700 underline"
                      onClick={() => void inspect(revision._id)}
                    >
                      Inspect
                    </button>
                  </div>
                </li>
              ))}
            </ol>
            {!loading && !loadError && meta.totalPages > 0 && (
              <div className="mt-5 flex items-center justify-between text-sm text-gray-600">
                <span>
                  Page {meta.page} of {meta.totalPages} · {meta.total} versions
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={meta.page <= 1}
                    onClick={() => {
                      setDetail(null);
                      setPage((value) => value - 1);
                    }}
                    className="rounded border px-3 py-1 disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={meta.page >= meta.totalPages}
                    onClick={() => {
                      setDetail(null);
                      setPage((value) => value + 1);
                    }}
                    className="rounded border px-3 py-1 disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}

            {(detailLoading || detailError || detail) && (
              <div className="mt-7 border-t border-gray-200 pt-5">
                {detailLoading && (
                  <p className="text-sm text-gray-500" role="status">
                    Loading revision…
                  </p>
                )}
                {detailError && (
                  <p className="rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">
                    {detailError}
                  </p>
                )}
                {detail && (
                  <>
                    <h3 className="text-base font-semibold text-gray-900">
                      {detail.snapshot.title}
                    </h3>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">
                      {detail.snapshot.excerpt || 'No excerpt.'}
                    </p>
                    <p className="mt-3 text-xs text-gray-500">
                      {detail.snapshot.tags.join(', ') || 'No tags'}
                    </p>
                    <div className="mt-4">
                      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                        Editorial source
                      </p>
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-gray-50 p-3 text-xs text-gray-700">
                        {detail.snapshot.content}
                      </pre>
                    </div>
                    {restoreError && (
                      <p
                        className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800"
                        role="alert"
                      >
                        {restoreError}
                      </p>
                    )}
                    <button
                      type="button"
                      className="mt-5 rounded-md bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800"
                      onClick={() => setConfirming(true)}
                    >
                      Restore this version
                    </button>
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      )}
      <AlertDialog.Root open={confirming} onOpenChange={setConfirming}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[100] bg-black/40" />
          <AlertDialog.Content className="fixed z-[101] left-1/2 top-1/2 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-xl">
            <AlertDialog.Title className="text-lg font-semibold text-gray-900">
              Restore this version?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-gray-600">
              The current version will remain available in version history.
              {hasUnsavedChanges && (
                <span className="mt-3 block font-medium text-amber-800">
                  You have unsaved editor changes. Restoring this version will discard those local
                  changes.
                </span>
              )}
              {isPublished && (
                <span className="mt-3 block font-medium text-amber-800">
                  This blog is currently published. Restoring this version may immediately update
                  its public content.
                </span>
              )}
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-3">
              <AlertDialog.Cancel
                disabled={restoring}
                className="rounded-md border px-4 py-2 text-sm text-gray-700"
              >
                Cancel
              </AlertDialog.Cancel>
              <AlertDialog.Action
                disabled={restoring}
                onClick={(event) => {
                  event.preventDefault();
                  void restore();
                }}
                className="rounded-md bg-green-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {restoring ? 'Restoring…' : 'Restore version'}
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}
