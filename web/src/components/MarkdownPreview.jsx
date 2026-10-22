import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Modal, Spinner, useToast } from './ui';
import { Markdown } from './Markdown';
import { DownloadIcon } from './icons';
import { formatNumber } from '../lib/format';

/**
 * The shared `.md` file of a document.
 *
 * Every document can be handed out as a single Markdown file: the content of
 * the active version with a small YAML front-matter header. The preview shows
 * the rendered file, the source tab shows the raw bytes and the download icon
 * saves it as `<title>.md`.
 */

/** Removes the YAML front matter so the preview starts with the content. */
function stripFrontMatter(markdown) {
  return String(markdown || '').replace(/^---\n[\s\S]*?\n---\n?/, '');
}

export function MarkdownPreview({ documentId, versionId, onClose }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('preview');

  const load = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    try {
      const res = await api.documentMarkdown(documentId, { versionId });
      setData(res.markdown);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [documentId, versionId, toast]);

  useEffect(() => {
    if (!documentId) {
      setData(null);
      return;
    }
    setData(null);
    setMode('preview');
    load();
  }, [documentId, versionId, load]);

  return (
    <Modal
      open={Boolean(documentId)}
      onClose={onClose}
      title={data?.filename || 'Markdown file'}
      wide
      footer={
        <>
          {documentId ? (
            <a
              href={api.documentMarkdownUrl(documentId, { versionId })}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
              title="Download the shared Markdown file"
            >
              <DownloadIcon className="h-4 w-4" /> Download .md
            </a>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {loading && !data ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Building the Markdown file…
        </div>
      ) : data ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
            <span>
              {data.filename} · version {data.versionNumber} · {formatNumber(data.characters)} characters
            </span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={mode === 'preview' ? 'secondary' : 'ghost'}
                onClick={() => setMode('preview')}
              >
                Preview
              </Button>
              <Button
                size="sm"
                variant={mode === 'source' ? 'secondary' : 'ghost'}
                onClick={() => setMode('source')}
              >
                Source
              </Button>
            </div>
          </div>

          {data.sourceUrl ? (
            <a
              href={data.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="block truncate text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              {data.sourceUrl}
            </a>
          ) : null}

          {mode === 'preview' ? (
            <div className="max-h-[60vh] overflow-y-auto rounded-md border border-slate-200 p-3 dark:border-slate-800">
              <Markdown>{stripFrontMatter(data.markdown)}</Markdown>
            </div>
          ) : (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
              {data.markdown}
            </pre>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-500">This document has no content to share yet.</p>
      )}
    </Modal>
  );
}
