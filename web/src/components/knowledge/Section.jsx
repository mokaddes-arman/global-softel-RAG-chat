import React from 'react';
import { cn } from '../ui';

/**
 * A titled card used by every panel of the knowledge base.
 *
 * The header carries the icon, the title, an optional explanation and an
 * optional action (usually a button on the right).
 */
export function Section({ icon, title, description, action, children, className = '' }) {
  return (
    <section
      className={cn(
        'rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40',
        className,
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <div className="flex min-w-0 items-center gap-2">
          {icon ? <span className="shrink-0 text-slate-400">{icon}</span> : null}
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-slate-800 dark:text-slate-100">{title}</h3>
            {description ? <p className="text-[11px] text-slate-400">{description}</p> : null}
          </div>
        </div>
        {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** Splits a pasted block of text into a list of URLs. */
export function splitUrls(text) {
  return String(text || '')
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A compact, read-only list of the URLs of a link list. */
export function UrlList({ urls, empty = 'No URLs yet.' }) {
  if (!urls?.length) return <p className="text-xs text-slate-400">{empty}</p>;
  return (
    <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
      {urls.map((url) => (
        <li key={url} className="truncate text-slate-600 dark:text-slate-300" title={url}>
          {url}
        </li>
      ))}
    </ul>
  );
}
