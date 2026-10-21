import { useState } from 'react';
import { useApp } from '../store';
import { api } from '../api';
import { Button, EmptyState, Field, Input, Select, Spinner, useToast } from '../components/ui';
import { SearchIcon } from '../components/icons';
import { SourceList } from '../components/SourceList';

export function SearchView() {
  const { activeProject } = useApp();
  const toast = useToast();

  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState('8');
  const [includeHistorical, setIncludeHistorical] = useState(false);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);

  const run = async () => {
    const q = query.trim();
    if (!q || !activeProject) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.projectSearch(activeProject.id, {
        q,
        topK,
        includeHistoricalVersions: includeHistorical ? 'true' : undefined,
      });
      setResult(data);
      setHistory((prev) => [q, ...prev.filter((x) => x !== q)].slice(0, 6));
    } catch (err) {
      setError(err.message);
      setResult(null);
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!activeProject) {
    return (
      <EmptyState
        icon={<SearchIcon className="h-8 w-8 text-slate-400" />}
        title="No project selected"
        description="Select a project to search its indexed documents."
      />
    );
  }

  const stats = result?.stats;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h1 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Search “{activeProject.name}”
        </h1>
        <p className="text-[11px] text-slate-400">
          Hybrid semantic + keyword retrieval. This shows the raw evidence the assistant would
          receive — no language model is called.
        </p>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Query" className="min-w-[240px] flex-1">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. How are refresh tokens issued?"
              onKeyDown={(e) => {
                if (e.key === 'Enter') run();
              }}
            />
          </Field>
          <Field label="Results">
            <Select value={topK} onChange={(e) => setTopK(e.target.value)}>
              {[3, 5, 8, 12, 20].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Button onClick={run} loading={loading} disabled={!query.trim()}>
            <SearchIcon className="h-4 w-4" /> Search
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 dark:text-slate-300">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={includeHistorical}
              onChange={(e) => setIncludeHistorical(e.target.checked)}
            />
            Include historical document versions
          </label>
        </div>

        {history.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            <span>Recent:</span>
            {history.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => {
                  setQuery(q);
                }}
                className="rounded-full border border-slate-200 px-2 py-0.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Searching…
          </div>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {stats && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500 dark:border-slate-700 dark:bg-slate-900">
            <span>returned {stats.returned ?? 0}</span>
            <span>vector candidates {stats.vectorCount ?? 0}</span>
            <span>keyword candidates {stats.keywordCount ?? 0}</span>
            <span>fused {stats.fusedCount ?? 0}</span>
            {Number.isFinite(stats.totalMs) && <span>in {stats.totalMs} ms</span>}
            {stats.rerankEnabled && <span>reranked</span>}
            {stats.reason && <span className="text-amber-600 dark:text-amber-400">reason: {stats.reason}</span>}
          </div>
        )}

        {result && (
          <SourceList
            sources={result.sources || []}
            emptyText={
              stats?.reason === 'no_projects'
                ? 'This project has no indexed chunks yet. Upload and index a document first.'
                : 'No relevant passages were found for that query.'
            }
          />
        )}
      </div>
    </div>
  );
}
