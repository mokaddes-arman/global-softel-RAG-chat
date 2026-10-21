import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { api } from '../api';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  statusTone,
  cn,
  useToast,
} from '../components/ui';
import {
  AlertIcon,
  DocIcon,
  DownloadIcon,
  RefreshIcon,
  TrashIcon,
  UploadIcon,
} from '../components/icons';
import { formatBytes, formatDate, formatNumber, formatRelative } from '../lib/format';

function statusBadge(status) {
  return <Badge tone={statusTone(status)}>{status}</Badge>;
}

function UploadPanel({ projectId, onUploaded }) {
  const toast = useToast();
  const [onDuplicate, setOnDuplicate] = useState('skip');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [duplicates, setDuplicates] = useState(null); // { files, entries }
  const inputRef = useRef(null);

  const send = useCallback(
    async (files, duplicateAction) => {
      if (!files.length) return;
      setUploading(true);
      try {
        const { ok, body } = await api.uploadFiles(projectId, files, duplicateAction);
        const results = body?.results || [];
        const accepted = results.filter((r) => r.ok);
        const rejectedDupes = results.filter((r) => r.error?.code === 'duplicate_document');
        const rejectedOther = results.filter((r) => !r.ok && r.error?.code !== 'duplicate_document');

        if (accepted.length) {
          toast.success(
            `${accepted.length} file${accepted.length === 1 ? '' : 's'} queued for indexing`,
          );
        }
        for (const r of rejectedOther) {
          toast.error(`${r.filename}: ${r.error?.message || 'upload failed'}`);
        }

        if (rejectedDupes.length) {
          // Keep the exact File objects so the user can re-submit them with a
          // different duplicate policy.
          const dupeNames = new Set(rejectedDupes.map((r) => r.filename));
          const dupeFiles = files.filter((f) => dupeNames.has(f.name));
          setDuplicates({ files: dupeFiles, entries: rejectedDupes });
        } else {
          setDuplicates(null);
        }

        if (ok || accepted.length) onUploaded();
      } catch (err) {
        toast.error(err.message);
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [projectId, onUploaded, toast],
  );

  const onFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length) send(files, onDuplicate);
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors',
          dragging
            ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30'
            : 'border-slate-300 dark:border-slate-700',
        )}
      >
        <UploadIcon className="h-6 w-6 text-slate-400" />
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Drag &amp; drop files here, or
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
        <Button size="sm" variant="outline" loading={uploading} onClick={() => inputRef.current?.click()}>
          Choose files
        </Button>
        <p className="text-[11px] text-slate-400">
          PDF, Office, text, markdown, CSV, JSON, YAML, HTML/XML and code files are supported.
        </p>
      </div>
      <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
        If a file is an exact duplicate:
        <select
          value={onDuplicate}
          onChange={(e) => setOnDuplicate(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="skip">Skip it</option>
          <option value="new_version">Add as a new version</option>
          <option value="new_document">Keep as a separate document</option>
        </select>
      </label>

      <Modal
        open={Boolean(duplicates)}
        onClose={() => setDuplicates(null)}
        title="Duplicate files detected"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDuplicates(null)} disabled={uploading}>
              Cancel
            </Button>
            <Button
              loading={uploading}
              onClick={async () => {
                const files = duplicates.files;
                setDuplicates(null);
                await send(files, onDuplicate === 'skip' ? 'new_version' : onDuplicate);
              }}
            >
              Re-upload with this policy
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
          <p>
            {duplicates?.entries.length} file{duplicates?.entries.length === 1 ? ' is' : 's are'}{' '}
            byte-for-byte identical to documents already in this project.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs">
            {duplicates?.entries.map((e) => (
              <li key={e.filename}>
                <span className="font-medium">{e.filename}</span> — matches “
                {e.error?.details?.existingTitle}” (version {e.error?.details?.existingVersionNumber})
              </li>
            ))}
          </ul>
          <p className="text-xs">
            The current policy is <span className="font-medium">{onDuplicate.replace('_', ' ')}</span>.
            “Skip” will not re-upload them.
          </p>
        </div>
      </Modal>
    </div>
  );
}

function VersionsModal({ documentId, onClose, onChanged }) {
  const toast = useToast();
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getDocument(documentId);
      setDoc(data.document);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [documentId, toast]);

  useEffect(() => {
    if (documentId) load();
  }, [documentId, load]);

  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={Boolean(documentId)} onClose={onClose} title={doc?.title || 'Document versions'} wide>
      {loading && !doc && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading…
        </div>
      )}
      {doc && (
        <div className="space-y-4">
          <div className="text-xs text-slate-500">
            {doc.original_filename} · {doc.file_ext?.toUpperCase()} · {formatBytes(doc.size_bytes)}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500 dark:border-slate-700">
                  <th className="py-1.5 pr-3">Ver</th>
                  <th className="py-1.5 pr-3">Status</th>
                  <th className="py-1.5 pr-3">Chunks</th>
                  <th className="py-1.5 pr-3">Size</th>
                  <th className="py-1.5 pr-3">Uploaded</th>
                  <th className="py-1.5 pr-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {doc.versions.map((v) => (
                  <tr key={v.id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-1.5 pr-3">
                      v{v.version_number}
                      {v.is_active && <Badge tone="blue" className="ml-1">active</Badge>}
                    </td>
                    <td className="py-1.5 pr-3">{statusBadge(v.status)}</td>
                    <td className="py-1.5 pr-3">{formatNumber(v.actual_chunk_count)}</td>
                    <td className="py-1.5 pr-3">{formatBytes(v.size_bytes)}</td>
                    <td className="py-1.5 pr-3">{formatRelative(v.uploaded_at)}</td>
                    <td className="py-1.5 pr-3">
                      <div className="flex flex-wrap gap-1">
                        <a
                          href={api.fileUrl(doc.id, { versionId: v.id, download: true })}
                          className="rounded px-1.5 py-0.5 text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
                        >
                          Download
                        </a>
                        {!v.is_active && v.status === 'indexed' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => act(() => api.activateVersion(doc.id, v.id))}
                            className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                          >
                            Activate
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => act(() => api.reindexDocument(doc.id, v.id))}
                          className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          Re-index
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {doc.jobs?.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Ingestion jobs
              </p>
              <ul className="space-y-1 text-xs">
                {doc.jobs.slice(0, 8).map((j) => (
                  <li key={j.id} className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">
                      {j.stage || j.status} · attempts {j.attempts}/{j.max_attempts}
                      {j.error ? ` · ${j.error}` : ''}
                    </span>
                    <span>{statusBadge(j.status)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function DocumentsView() {
  const { activeProject, refreshSystemStatus } = useApp();
  const toast = useToast();

  const [documents, setDocuments] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);

  const [versionsDocId, setVersionsDocId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [jobs, setJobs] = useState([]);

  const versionInputRef = useRef(null);
  const versionTargetRef = useRef(null);
  const pollRef = useRef(null);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!activeProject) return;
      if (!silent) setLoading(true);
      try {
        const data = await api.projectDocuments(activeProject.id, {
          search: search || undefined,
          status: status || undefined,
          includeArchived: includeArchived ? 'true' : undefined,
          limit: 200,
        });
        setDocuments(data.documents || []);
        setTotal(data.total || 0);
        const jobData = await api.projectJobs(activeProject.id, { limit: 50 }).catch(() => ({ jobs: [] }));
        setJobs(jobData.jobs || []);
      } catch (err) {
        toast.error(err.message);
      } finally {
        setLoading(false);
      }
    },
    [activeProject, search, status, includeArchived, toast],
  );

  // Debounced initial/filtered load.
  useEffect(() => {
    const t = window.setTimeout(() => load(), 250);
    return () => window.clearTimeout(t);
  }, [load]);

  // Poll while anything is still processing.
  const anyActive = useMemo(
    () =>
      documents.some((d) => d.status === 'pending' || d.status === 'processing' || d.active_jobs > 0) ||
      jobs.some((j) => j.status === 'queued' || j.status === 'processing'),
    [documents, jobs],
  );

  useEffect(() => {
    if (!anyActive) return undefined;
    pollRef.current = window.setTimeout(() => {
      load({ silent: true }).then(() => refreshSystemStatus());
    }, 3000);
    return () => window.clearTimeout(pollRef.current);
  }, [anyActive, documents, jobs, load, refreshSystemStatus]);

  const triggerAddVersion = (doc) => {
    versionTargetRef.current = doc;
    versionInputRef.current?.click();
  };

  const onVersionFile = async (fileList) => {
    const file = fileList?.[0];
    const doc = versionTargetRef.current;
    versionTargetRef.current = null;
    if (versionInputRef.current) versionInputRef.current.value = '';
    if (!file || !doc) return;
    setBusyId(doc.id);
    try {
      const { ok, body } = await api.addVersion(doc.id, file);
      if (ok) toast.success(`New version queued for "${doc.title}"`);
      else toast.error(body?.error?.message || body?.result?.error?.message || 'Version upload failed');
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteDocument(pendingDelete.id);
      toast.success(
        pendingDelete.archived ? 'Document permanently deleted' : 'Document archived',
      );
      await load({ silent: true });
      refreshSystemStatus();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  const restore = async (doc) => {
    setBusyId(doc.id);
    try {
      await api.restoreDocument(doc.id);
      toast.success('Document restored');
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const reindex = async (doc) => {
    setBusyId(doc.id);
    try {
      await api.reindexDocument(doc.id);
      toast.success('Re-index queued');
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const retryJob = async (job) => {
    try {
      await api.retryJob(job.id);
      toast.success('Job re-queued');
      await load({ silent: true });
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!activeProject) {
    return (
      <EmptyState
        icon={<DocIcon className="h-8 w-8 text-slate-400" />}
        title="No project selected"
        description="Select a project to manage its documents."
      />
    );
  }

  const failedJobs = jobs.filter((j) => j.status === 'failed');

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Documents</h1>
            <p className="text-[11px] text-slate-400">
              {formatNumber(total)} document{total === 1 ? '' : 's'} in “{activeProject.name}”
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => load()} disabled={loading}>
            <RefreshIcon className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <UploadPanel projectId={activeProject.id} onUploaded={() => load({ silent: true })} />

        {failedJobs.length > 0 && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/40">
            <p className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-300">
              <AlertIcon className="h-4 w-4" /> {failedJobs.length} ingestion job
              {failedJobs.length === 1 ? '' : 's'} failed
            </p>
            <ul className="mt-2 space-y-1 text-xs text-red-700 dark:text-red-300">
              {failedJobs.slice(0, 5).map((j) => (
                <li key={j.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {j.document_title || 'Document'} — {j.error || j.error_code || 'unknown error'}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => retryJob(j)}>
                    Retry
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <Field label="Search" className="min-w-[200px] flex-1">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by title or filename"
            />
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
              <option value="indexed">Indexed</option>
              <option value="failed">Failed</option>
              <option value="archived">Archived</option>
            </Select>
          </Field>
          <label className="mb-1.5 inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Include archived
          </label>
        </div>

        {loading && !documents.length ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading documents…
          </div>
        ) : documents.length === 0 ? (
          <EmptyState
            icon={<DocIcon className="h-8 w-8 text-slate-400" />}
            title="No documents yet"
            description="Upload a PDF, Word document, spreadsheet or text file to build this project's knowledge base."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-900">
                <tr>
                  <th className="px-3 py-2">Document</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Ver</th>
                  <th className="px-3 py-2">Chunks</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Updated</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr
                    key={doc.id}
                    className="border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900/60"
                  >
                    <td className="max-w-[260px] px-3 py-2">
                      <div className="flex items-center gap-2">
                        <DocIcon className="h-4 w-4 shrink-0 text-slate-400" />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-800 dark:text-slate-100" title={doc.title}>
                            {doc.title}
                          </p>
                          <p className="truncate text-[11px] text-slate-400">
                            {doc.original_filename}
                            {doc.file_ext ? ` · ${doc.file_ext.toUpperCase()}` : ''}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">{statusBadge(doc.status)}</td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                      v{doc.current_version_number ?? 1}
                      {doc.version_count > 1 && (
                        <span className="ml-1 text-[11px] text-slate-400">({doc.version_count})</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                      {formatNumber(doc.chunk_count_actual)}
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                      {formatBytes(doc.size_bytes)}
                    </td>
                    <td className="px-3 py-2 text-slate-500">{formatRelative(doc.updated_at)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        <a
                          href={api.fileUrl(doc.id, { download: true })}
                          className="rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                          title="Download"
                        >
                          <DownloadIcon className="h-3.5 w-3.5" />
                        </a>
                        <Button size="sm" variant="ghost" onClick={() => setVersionsDocId(doc.id)}>
                          Versions
                        </Button>
                        {doc.archived ? (
                          <Button size="sm" variant="ghost" onClick={() => restore(doc)} loading={busyId === doc.id}>
                            Restore
                          </Button>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => triggerAddVersion(doc)}
                              loading={busyId === doc.id}
                            >
                              New version
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => reindex(doc)}
                              disabled={doc.status === 'processing'}
                            >
                              Re-index
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setPendingDelete(doc)}
                              title="Delete"
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <input
        ref={versionInputRef}
        type="file"
        className="hidden"
        onChange={(e) => onVersionFile(e.target.files)}
      />

      <VersionsModal
        documentId={versionsDocId}
        onClose={() => setVersionsDocId(null)}
        onChanged={() => load({ silent: true })}
      />
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title="Delete document"
        confirmLabel="Archive document"
        message={
          pendingDelete
            ? `Archive "${pendingDelete.title}"? It stays in version history and citations remain valid, but it is excluded from retrieval. Use “Include archived” to restore it.`
            : ''
        }
      />
    </div>
  );
}
