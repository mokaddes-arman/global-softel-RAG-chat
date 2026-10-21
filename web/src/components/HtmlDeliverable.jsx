import { useMemo, useState } from 'react';
import { Button } from './ui';

/**
 * Renders a fenced ```html block from an assistant answer as a deliverable:
 * a read-only code view plus Preview / Copy / Download actions.
 *
 * Security: the HTML is never injected into this page. The code view shows it
 * as plain text, and the preview renders it inside an iframe with an empty
 * `sandbox` attribute (no scripts, no same-origin, no forms, no navigation),
 * so a model-authored document cannot run code against the app or steal data.
 */

function downloadHtml(filename, html) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function HtmlDeliverable({ code, filename = 'deliverable.html' }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const lineCount = useMemo(() => (code ? code.split('\n').length : 0), [code]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5 dark:border-slate-700 dark:bg-slate-800/60">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          HTML deliverable · {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => setPreviewOpen(true)}>
            Preview
          </Button>
          <Button size="sm" variant="outline" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => downloadHtml(filename, code)}>
            Download
          </Button>
        </div>
      </div>
      <pre className="max-h-80 overflow-auto bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-100">
        <code>{code}</code>
      </pre>

      {previewOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="HTML deliverable preview"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-slate-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-2 dark:border-slate-700">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-100">
                HTML deliverable preview
              </h3>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" onClick={() => downloadHtml(filename, code)}>
                  Download
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setPreviewOpen(false)}>
                  Close
                </Button>
              </div>
            </div>
            <iframe
              title="HTML deliverable preview"
              className="min-h-0 w-full flex-1 bg-white"
              sandbox=""
              srcDoc={code}
            />
          </div>
        </div>
      )}
    </div>
  );
}
