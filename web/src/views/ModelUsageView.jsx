import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import {
  Badge,
  Button,
  EmptyState,
  Select,
  Spinner,
  cn,
  useToast,
} from '../components/ui';
import { AlertIcon, ChartIcon, RefreshIcon } from '../components/icons';
import { formatDate, formatNumber } from '../lib/format';

/** Local calendar date -> "YYYY-MM-DD". */
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

function startOfMonth() {
  const d = new Date();
  d.setDate(1);
  return isoDate(d);
}

function startOfYear() {
  const d = new Date();
  d.setMonth(0, 1);
  return isoDate(d);
}

/** Compact token counts (1.6M, 12.3K) for dense tables. */
function compact(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

const PRESETS = [
  { id: 'today', label: 'Today', range: () => ({ from: isoDate(new Date()), to: isoDate(new Date()) }) },
  { id: '7d', label: 'Last 7 days', range: () => ({ from: daysAgo(6), to: isoDate(new Date()) }) },
  { id: '30d', label: 'Last 30 days', range: () => ({ from: daysAgo(29), to: isoDate(new Date()) }) },
  { id: 'month', label: 'This month', range: () => ({ from: startOfMonth(), to: isoDate(new Date()) }) },
  { id: 'year', label: 'This year', range: () => ({ from: startOfYear(), to: isoDate(new Date()) }) },
];

const GRANULARITIES = [
  { id: 'day', label: 'Daily' },
  { id: 'week', label: 'Weekly' },
  { id: 'month', label: 'Monthly' },
  { id: 'year', label: 'Yearly' },
];

function SummaryCard({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100">{value}</p>
      {sub ? <p className="text-[11px] text-slate-400">{sub}</p> : null}
    </div>
  );
}

function BucketChart({ buckets }) {
  const max = Math.max(1, ...buckets.map((b) => b.totalTokens));
  return (
    <div className="space-y-1.5">
      {buckets.map((b) => (
        <div key={b.label} className="flex items-center gap-2 text-xs">
          <span className="w-24 shrink-0 truncate text-slate-400" title={b.label}>
            {b.label}
          </span>
          <div className="h-4 min-w-0 flex-1 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
            <div
              className="h-full rounded bg-blue-500/80"
              style={{ width: `${Math.max(2, Math.round((b.totalTokens / max) * 100))}%` }}
              title={`${formatNumber(b.totalTokens)} tokens · ${formatNumber(b.requests)} requests`}
            />
          </div>
          <span className="w-16 shrink-0 text-right font-medium text-slate-600 dark:text-slate-300">
            {compact(b.totalTokens)}
          </span>
          <span className="w-20 shrink-0 text-right text-slate-400">
            {formatNumber(b.requests)} req
          </span>
        </div>
      ))}
    </div>
  );
}

export function ModelUsageView() {
  const toast = useToast();
  const [preset, setPreset] = useState('30d');
  const [from, setFrom] = useState(() => daysAgo(29));
  const [to, setTo] = useState(() => isoDate(new Date()));
  const [granularity, setGranularity] = useState('day');

  const [data, setData] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Send explicit instants so "from"/"to" mean local calendar days.
      const payload = {
        from: new Date(`${from}T00:00:00`).toISOString(),
        to: new Date(`${to}T23:59:59.999`).toISOString(),
        granularity,
      };
      const result = await api.modelUsage(payload);
      setData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [from, to, granularity]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .modelUsageCatalog()
      .then(setCatalog)
      .catch(() => setCatalog({ configured: false, models: [] }));
  }, []);

  const applyPreset = (p) => {
    setPreset(p.id);
    const { from: f, to: t } = p.range();
    setFrom(f);
    setTo(t);
  };

  const limitByModel = useMemo(() => {
    const map = new Map();
    for (const m of catalog?.models || []) map.set(m.id, m.limit);
    return map;
  }, [catalog]);

  const totals = data?.totals;
  const models = data?.models || [];
  const hasUsage = models.length > 0;

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div>
          <h1 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
            <ChartIcon className="h-4 w-4" /> Model usage
          </h1>
          <p className="text-[11px] text-slate-400">
            Token usage per model across every question answered in this app
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
          <RefreshIcon className="h-3.5 w-3.5" /> Refresh
        </Button>
      </header>

      <div className="space-y-5 p-4">
        {/* Filters */}
        <section className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Period
              </p>
              <div className="flex flex-wrap gap-1">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-xs font-medium',
                      preset === p.id
                        ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-200'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-end gap-2">
              <label className="text-xs text-slate-500">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  From
                </span>
                <input
                  type="date"
                  value={from}
                  max={to}
                  onChange={(e) => {
                    setPreset('custom');
                    setFrom(e.target.value);
                  }}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
              <label className="text-xs text-slate-500">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  To
                </span>
                <input
                  type="date"
                  value={to}
                  min={from}
                  onChange={(e) => {
                    setPreset('custom');
                    setTo(e.target.value);
                  }}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
            </div>

            <label className="text-xs text-slate-500">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Group by
              </span>
              <Select value={granularity} onChange={(e) => setGranularity(e.target.value)} className="min-w-[8rem]">
                {GRANULARITIES.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        </section>

        {error && (
          <p className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
            <AlertIcon className="h-4 w-4" /> {error}
          </p>
        )}

        {loading && !data ? (
          <div className="flex items-center gap-2 p-4 text-sm text-slate-500">
            <Spinner /> Loading usage…
          </div>
        ) : !hasUsage ? (
          <EmptyState
            icon={<ChartIcon className="h-8 w-8 text-slate-400" />}
            title="No model usage in this period"
            description="Ask a question in Chat and the concrete model used, along with its token counts, will appear here."
          />
        ) : (
          <>
            {/* Summary */}
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <SummaryCard label="Requests" value={formatNumber(totals.requests)} />
              <SummaryCard label="Input tokens" value={formatNumber(totals.inputTokens)} />
              <SummaryCard label="Output tokens" value={formatNumber(totals.outputTokens)} />
              <SummaryCard
                label="Total tokens"
                value={formatNumber(totals.totalTokens)}
                sub={`${formatNumber(totals.avgTokensPerRequest)} avg / request`}
              />
              <SummaryCard label="Models used" value={formatNumber(totals.modelCount)} />
            </section>

            {/* Over time */}
            {data.buckets.length > 0 && (
              <section className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Usage over time (total tokens)
                </h2>
                <BucketChart buckets={data.buckets} />
              </section>
            )}

            {/* Per model */}
            <section className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Per model
                </h2>
                {catalog?.error ? (
                  <span className="text-[11px] text-amber-600 dark:text-amber-400">
                    OpenCode limits unavailable
                  </span>
                ) : null}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-400 dark:bg-slate-900/60">
                    <tr>
                      <th className="px-3 py-2 font-medium">Model</th>
                      <th className="px-3 py-2 font-medium">Provider</th>
                      <th className="px-3 py-2 text-right font-medium">Requests</th>
                      <th className="px-3 py-2 text-right font-medium">Input</th>
                      <th className="px-3 py-2 text-right font-medium">Output</th>
                      <th className="px-3 py-2 text-right font-medium">Total</th>
                      <th className="px-3 py-2 text-right font-medium">Avg / req</th>
                      <th className="px-3 py-2 text-right font-medium">Limits (ctx / out)</th>
                      <th className="px-3 py-2 font-medium">Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m) => {
                      const limit = limitByModel.get(m.model);
                      return (
                        <tr key={`${m.provider}:${m.model}`} className="border-t border-slate-100 dark:border-slate-800">
                          <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-100">
                            <span className="inline-flex items-center gap-1.5">
                              {m.model}
                              {limit ? <Badge tone="blue">OpenCode</Badge> : null}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-slate-500">{m.provider || '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatNumber(m.requests)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatNumber(m.inputTokens)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatNumber(m.outputTokens)}</td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">
                            {formatNumber(m.totalTokens)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                            {formatNumber(m.avgTokensPerRequest)}
                          </td>
                          <td className="px-3 py-2 text-right text-[11px] text-slate-400">
                            {limit
                              ? `${limit.context ? compact(limit.context) : '—'} / ${limit.output ? compact(limit.output) : '—'}`
                              : '—'}
                          </td>
                          <td className="px-3 py-2 text-[11px] text-slate-400">{formatDate(m.lastUsed)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-slate-50 text-[13px] font-medium dark:bg-slate-900/60">
                    <tr>
                      <td className="px-3 py-2" colSpan={2}>
                        Total
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(totals.requests)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(totals.inputTokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(totals.outputTokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(totals.totalTokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(totals.avgTokensPerRequest)}</td>
                      <td className="px-3 py-2" colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            {catalog?.configured && (catalog.serial || catalog.models?.length) ? (
              <p className="text-[11px] text-slate-400">
                OpenCode free models are tried in order and the first that answers wins. Your fallback
                serial: <code className="break-all">{catalog.serial || '—'}</code>.
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
