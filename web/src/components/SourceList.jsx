import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Button, Modal, Spinner, cn, useToast } from './ui';
import { DocIcon, CopyIcon, SearchIcon } from './icons';
import { formatNumber } from '../lib/format';
import { normaliseSource } from '../lib/sources';

/** Copy text to the clipboard, tolerating insecure (http) contexts. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function scoreLabel(source) {
  const parts = [];
  if (Number.isFinite(source.vectorScore)) parts.push(`vector ${source.vectorScore.toFixed(3)}`);
  if (Number.isFinite(source.keywordScore)) parts.push(`keyword ${source.keywordScore.toFixed(3)}`);
  if (!parts.length && Number.isFinite(source.score)) parts.push(`score ${source.score.toFixed(3)}`);
  return parts.join(' · ');
}

function SourceRow({ source, onInspect }) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const s = normaliseSource(source);

  const citation = `[${s.rank ?? '?'}] "${s.documentTitle}" (v${s.documentVersionNumber ?? '?'}) — ${s.sourceLocation}`;

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-start gap-2">
        <Badge tone="blue" className="mt-0.5 shrink-0">
          [{s.rank ?? '?'}]
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100" title={s.documentTitle}>
            {s.documentTitle}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            version {s.documentVersionNumber ?? '?'} · {s.sourceLocation}
            {s.isActiveVersion === false && (
              <span className="ml-1 text-amber-600 dark:text-amber-400">· historical version</span>
            )}
          </p>
          {scoreLabel(s) && <p className="mt-0.5 text-[11px] text-slate-400">{scoreLabel(s)}</p>}

          {expanded && (
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">
              {s.excerpt}
            </pre>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Hide excerpt' : 'Show excerpt'}
            </Button>
            {s.chunkId && (
              <Button size="sm" variant="ghost" onClick={() => onInspect(s.chunkId)}>
                <SearchIcon className="h-3.5 w-3.5" /> Inspect chunk
              </Button>
            )}
            {s.documentId && (
              <a
                href={api.fileUrl(s.documentId, { versionId: s.documentVersionId })}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <DocIcon className="h-3.5 w-3.5" /> Open document
              </a>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const ok = await copyText(citation);
                if (ok) toast.success('Citation copied');
                else toast.error('Could not access the clipboard');
              }}
            >
              <CopyIcon className="h-3.5 w-3.5" /> Copy citation
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}

/** A modal that fetches and shows the full stored chunk for a citation. */
export function ChunkModal({ chunkId, open, onClose }) {
  const [chunk, setChunk] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !chunkId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setChunk(null);
    api
      .getChunk(chunkId)
      .then((data) => {
        if (!cancelled) setChunk(data.chunk);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, chunkId]);

  return (
    <Modal open={open} onClose={onClose} title="Source chunk" wide>
      {loading && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading chunk…
        </div>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error.message}</p>}
      {chunk && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300 sm:grid-cols-3">
            <div>
              <span className="text-slate-400">Document</span>
              <p className="font-medium text-slate-800 dark:text-slate-100">{chunk.document_title}</p>
            </div>
            <div>
              <span className="text-slate-400">Chunk</span>
              <p className="font-medium">#{chunk.chunk_index}</p>
            </div>
            <div>
              <span className="text-slate-400">Version</span>
              <p className="font-medium">
                v{chunk.version_number}
                {chunk.is_active ? '' : ' (history)'}
              </p>
            </div>
            <div>
              <span className="text-slate-400">Tokens</span>
              <p className="font-medium">{formatNumber(chunk.token_count)}</p>
            </div>
            <div>
              <span className="text-slate-400">Characters</span>
              <p className="font-medium">{formatNumber(chunk.char_count)}</p>
            </div>
            <div>
              <span className="text-slate-400">Chunk ID</span>
              <p className="truncate font-mono text-[11px]" title={chunk.id}>
                {chunk.id}
              </p>
            </div>
          </div>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-xs text-slate-800 dark:bg-slate-950 dark:text-slate-200">
            {chunk.content}
          </pre>
        </div>
      )}
    </Modal>
  );
}

/**
 * Renders retrieved sources as citation cards. `emptyText` customises the
 * no-sources message (e.g. when an answer abstained).
 */
export function SourceList({ sources = [], emptyText = 'No sources were retrieved.' }) {
  const [inspectId, setInspectId] = useState(null);
  if (!sources.length) {
    return <p className="text-xs text-slate-500">{emptyText}</p>;
  }
  return (
    <>
      <ul className={cn('space-y-2')}>
        {sources.map((source, i) => (
          <SourceRow key={source.id || source.chunkId || i} source={source} onInspect={setInspectId} />
        ))}
      </ul>
      <ChunkModal chunkId={inspectId} open={Boolean(inspectId)} onClose={() => setInspectId(null)} />
    </>
  );
}
