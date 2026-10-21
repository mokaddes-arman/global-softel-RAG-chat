import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api } from '../api';
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  cn,
  useToast,
} from '../components/ui';
import { AlertIcon, CheckIcon, PlusIcon, RefreshIcon, SettingsIcon } from '../components/icons';
import { formatDate, formatNumber } from '../lib/format';

function StatusPill({ ok, children }) {
  return (
    <Badge tone={ok ? 'green' : 'red'}>
      {ok ? <CheckIcon className="mr-0.5 h-3 w-3" /> : <AlertIcon className="mr-0.5 h-3 w-3" />}
      {children}
    </Badge>
  );
}

function TestResult({ result }) {
  if (!result) return null;
  return (
    <p
      className={cn(
        'text-xs',
        result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
      )}
    >
      {result.ok ? '✓ ' : '✗ '}
      {result.message}
      {Number.isFinite(result.latencyMs) ? ` (${result.latencyMs} ms)` : ''}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* LLM provider configuration form                                            */
/* -------------------------------------------------------------------------- */

function LlmConfigForm({ open, onClose, config, metadata }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState(null);

  const llmProviders = metadata?.llm || [];

  useEffect(() => {
    if (!open) return;
    setTestResult(null);
    setApiKey('');
    setClearKey(false);
    setError(null);
    setForm(
      config
        ? {
            name: config.name,
            provider: config.provider,
            model: config.model,
            baseUrl: config.base_url || '',
            enabled: config.enabled,
            isDefaultChat: config.is_default_chat,
          }
        : {
            name: '',
            provider: llmProviders[0]?.id || 'openrouter',
            model: '',
            baseUrl: '',
            enabled: true,
            isDefaultChat: false,
          },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, config]);

  const selected = useMemo(
    () => llmProviders.find((p) => p.id === form?.provider),
    [llmProviders, form?.provider],
  );

  if (!form) return null;

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const chooseProvider = (providerId) => {
    const p = llmProviders.find((x) => x.id === providerId);
    setForm((prev) => ({
      ...prev,
      provider: providerId,
      // OpenCode's "model" is the ordered fallback serial; offer it as a prefill.
      model: !prev.model && p?.defaultModel ? p.defaultModel : prev.model,
    }));
  };

  const submit = async () => {
    if (!form.name.trim()) return setError('A friendly name is required.');
    if (!form.model.trim()) return setError('A model name is required.');
    if (!config && selected?.requiresKey && !apiKey.trim()) {
      return setError('This provider requires an API key.');
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        provider: form.provider,
        model: form.model.trim(),
        baseUrl: form.baseUrl.trim() || null,
        enabled: form.enabled,
        isDefaultChat: form.isDefaultChat,
      };
      if (clearKey) payload.apiKey = null;
      else if (apiKey.trim()) payload.apiKey = apiKey.trim();

      if (config) await api.updateLlmConfig(config.id, payload);
      else await api.createLlmConfig(payload);
      toast.success(config ? 'Provider updated' : 'Provider added');
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      let result;
      if (config) {
        result = await api.testLlmConfig(config.id);
      } else {
        result = await api.testLlmAdHoc({
          provider: form.provider,
          model: form.model.trim(),
          baseUrl: form.baseUrl.trim() || null,
          apiKey: apiKey.trim() || null,
        });
      }
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: err.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={config ? 'Edit AI provider' : 'Add AI provider'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="outline" onClick={runTest} loading={testing} disabled={saving}>
            Test connection
          </Button>
          <Button onClick={submit} loading={saving}>
            {config ? 'Save changes' : 'Add provider'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && (
          <p className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}
        <Field label="Friendly name" required>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. GPT-4o (production)" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Provider" required>
            <Select value={form.provider} onChange={(e) => chooseProvider(e.target.value)}>
              {llmProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Model"
            required
            hint={undefined}
          >
            <Input value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="gpt-4o-mini" />
          </Field>
        </div>
        <Field
          label="Base URL"
          hint={selected?.defaultBaseUrl ? `Leave blank to use ${selected.defaultBaseUrl}` : 'Optional custom endpoint'}
        >
          <Input value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder={selected?.defaultBaseUrl || ''} />
        </Field>
        <Field
          label="API key"
          hint={
            config?.hasKey
              ? `A key is stored (${config.keyMasked}). Leave blank to keep it.`
              : 'Stored encrypted at rest (AES-256-GCM). Never shown again in full.'
          }
        >
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            disabled={clearKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.hasKey ? '•••••••• (unchanged)' : 'sk-…'}
          />
        </Field>
        {config?.hasKey && (
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
            Remove the stored key
          </label>
        )}
        <div className="flex flex-wrap gap-4 text-xs text-slate-600 dark:text-slate-300">
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            Enabled
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.isDefaultChat}
              onChange={(e) => set('isDefaultChat', e.target.checked)}
            />
            Use as the default chat provider
          </label>
        </div>
        <TestResult result={testResult} />
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Embedding configuration form                                               */
/* -------------------------------------------------------------------------- */

function EmbeddingConfigForm({ open, onClose, config, metadata }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const embeddingProviders = metadata?.embedding || [];

  useEffect(() => {
    if (!open) return;
    setApiKey('');
    setClearKey(false);
    setError(null);
    setForm(
      config
        ? {
            name: config.name,
            provider: config.provider,
            model: config.model,
            dimension: String(config.dimension),
            baseUrl: config.base_url || '',
            enabled: config.enabled,
            isDefault: config.is_default,
          }
        : {
            name: '',
            provider: embeddingProviders[0]?.id || 'local',
            model: '',
            dimension: '384',
            baseUrl: '',
            enabled: true,
            isDefault: false,
          },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, config]);

  const selected = useMemo(
    () => embeddingProviders.find((p) => p.id === form?.provider),
    [embeddingProviders, form?.provider],
  );

  if (!form) return null;
  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const chooseModel = (modelId) => {
    const known = selected?.knownModels?.find((m) => m.id === modelId);
    setForm((prev) => ({
      ...prev,
      model: modelId,
      dimension: known ? String(known.dimension) : prev.dimension,
    }));
  };

  const submit = async () => {
    if (!form.name.trim()) return setError('A friendly name is required.');
    if (!form.model.trim()) return setError('A model name is required.');
    const dimension = Number.parseInt(form.dimension, 10);
    if (!Number.isFinite(dimension) || dimension < 1) return setError('Dimension must be a positive integer.');
    if (!config && selected?.requiresKey && !apiKey.trim()) return setError('This provider requires an API key.');
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        provider: form.provider,
        model: form.model.trim(),
        dimension,
        baseUrl: form.baseUrl.trim() || null,
        enabled: form.enabled,
        isDefault: form.isDefault,
      };
      if (clearKey) payload.apiKey = null;
      else if (apiKey.trim()) payload.apiKey = apiKey.trim();

      if (config) await api.updateEmbeddingConfig(config.id, payload);
      else await api.createEmbeddingConfig(payload);
      toast.success(config ? 'Embedding model updated' : 'Embedding model added');
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={config ? 'Edit embedding model' : 'Add embedding model'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving}>
            {config ? 'Save changes' : 'Add model'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && (
          <p className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}
        <Field label="Friendly name" required>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Local MiniLM" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Provider" required>
            <Select
              value={form.provider}
              onChange={(e) => {
                const provider = e.target.value;
                const known = embeddingProviders.find((p) => p.id === provider)?.knownModels?.[0];
                setForm((prev) => ({
                  ...prev,
                  provider,
                  model: known?.id || prev.model,
                  dimension: known ? String(known.dimension) : prev.dimension,
                }));
              }}
            >
              {embeddingProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model" required hint="Pick a known model or type any model id">
            <Input
              list="embedding-models"
              value={form.model}
              onChange={(e) => chooseModel(e.target.value)}
              placeholder={selected?.knownModels?.[0]?.id || 'model-id'}
            />
            <datalist id="embedding-models">
              {(selected?.knownModels || []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.dimension} dims
                </option>
              ))}
            </datalist>
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Vector dimension" required hint="Must match EMBEDDING_DIM in .env">
            <Input
              type="number"
              value={form.dimension}
              onChange={(e) => set('dimension', e.target.value)}
              min={1}
              max={8192}
            />
          </Field>
          <Field label="Base URL" hint={selected?.defaultBaseUrl ? `Default: ${selected.defaultBaseUrl}` : 'Optional'}>
            <Input value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
          </Field>
        </div>
        <Field
          label="API key"
          hint={config?.hasKey ? `A key is stored (${config.keyMasked}). Leave blank to keep it.` : 'Only needed for hosted providers.'}
        >
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            disabled={clearKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.hasKey ? '•••••••• (unchanged)' : ''}
          />
        </Field>
        {config?.hasKey && (
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
            Remove the stored key
          </label>
        )}
        <div className="flex flex-wrap gap-4 text-xs text-slate-600 dark:text-slate-300">
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            Enabled
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={form.isDefault} onChange={(e) => set('isDefault', e.target.checked)} />
            Use as the active embedding model
          </label>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Settings page                                                              */
/* -------------------------------------------------------------------------- */

export function SettingsView() {
  const { systemStatus, refreshSystemStatus, theme, setTheme } = useApp();
  const toast = useToast();

  const [metadata, setMetadata] = useState(null);
  const [llmConfigs, setLlmConfigs] = useState([]);
  const [embeddingConfigs, setEmbeddingConfigs] = useState([]);
  const [indexStatus, setIndexStatus] = useState(null);
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);

  const [llmForm, setLlmForm] = useState(null); // { config } or { config: null }
  const [embeddingForm, setEmbeddingForm] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null); // { kind, config }
  const [deleting, setDeleting] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [meta, llm, emb, idx, st] = await Promise.all([
        api.providerMetadata().catch(() => ({ llm: [], embedding: [] })),
        api.listLlmConfigs().catch(() => ({ configs: [] })),
        api.listEmbeddingConfigs().catch(() => ({ configs: [] })),
        api.embeddingIndex().catch(() => null),
        api.getSettings().catch(() => ({ settings: {} })),
      ]);
      setMetadata(meta);
      setLlmConfigs(llm.configs || []);
      setEmbeddingConfigs(emb.configs || []);
      setIndexStatus(idx);
      setSettings(st.settings || {});
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const setDefaultChat = async (config) => {
    try {
      await api.setDefaultChat(config.id);
      toast.success(`"${config.name}" is now the default`);
      await loadAll();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const setDefaultEmbedding = async (config) => {
    try {
      await api.setDefaultEmbedding(config.id);
      toast.success(`"${config.name}" is now active`);
      await Promise.all([loadAll(), refreshSystemStatus()]);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      if (pendingDelete.kind === 'llm') await api.deleteLlmConfig(pendingDelete.config.id);
      else await api.deleteEmbeddingConfig(pendingDelete.config.id);
      toast.success('Configuration deleted');
      await loadAll();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  const updatePreference = async (key, value) => {
    try {
      await api.updateSetting(key, value);
      setSettings((prev) => ({ ...prev, [key]: value }));
      toast.success('Preference saved');
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div>
          <h1 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Settings</h1>
          <p className="text-[11px] text-slate-400">Providers, embedding models, and system health</p>
        </div>
        <Button size="sm" variant="ghost" onClick={loadAll} disabled={loading}>
          <RefreshIcon className="h-3.5 w-3.5" /> Refresh
        </Button>
      </header>

      <div className="space-y-6 p-4">
        {/* System status */}
        <section className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            System status
          </h2>
          {systemStatus ? (
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <p className="text-xs text-slate-400">Database</p>
                <p className="font-medium text-slate-800 dark:text-slate-100">
                  {systemStatus.database?.backend}
                </p>
                <p className="text-[11px] text-slate-400">
                  {formatNumber(systemStatus.database?.applied)} migrations applied
                  {systemStatus.database?.pending ? `, ${systemStatus.database.pending} pending` : ''}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Indexed chunks</p>
                <p className="font-medium text-slate-800 dark:text-slate-100">
                  {formatNumber(systemStatus.counts?.chunks)}
                </p>
                <p className="text-[11px] text-slate-400">
                  {formatNumber(systemStatus.counts?.documents)} documents
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Embedding model</p>
                <p className="truncate font-medium text-slate-800 dark:text-slate-100">
                  {indexStatus?.active ? `${indexStatus.active.provider}:${indexStatus.active.model}` : '—'}
                </p>
                <p className="text-[11px] text-slate-400">
                  {indexStatus?.active?.dimension ?? '—'} dims
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Hosted AI</p>
                <StatusPill ok={!systemStatus.hostedAi?.disabled}>
                  {systemStatus.hostedAi?.disabled ? 'Disabled' : 'Enabled'}
                </StatusPill>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-400">Loading…</p>
          )}
          {indexStatus?.needsReindex && (
            <p className="mt-3 flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              <AlertIcon className="h-4 w-4" />
              {formatNumber(indexStatus.staleChunks)} chunk(s) were indexed with a different model.
              Open a document and use “Re-index” to refresh them.
            </p>
          )}
          {indexStatus?.error && (
            <p className="mt-3 text-xs text-red-600 dark:text-red-400">{indexStatus.error.message}</p>
          )}
        </section>

        {/* LLM providers */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              AI providers (chat)
            </h2>
            <Button size="sm" onClick={() => setLlmForm({ config: null })} disabled={!metadata}>
              <PlusIcon className="h-3.5 w-3.5" /> Add provider
            </Button>
          </div>
          {loading && !llmConfigs.length ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Spinner /> Loading…
            </div>
          ) : llmConfigs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500 dark:border-slate-700">
              No providers configured. The environment default (
              {metadata?.llm?.[0]?.id || 'openrouter'}) is used without a key until you add one. Add a
              provider to enable grounded answers.
            </p>
          ) : (
            <ul className="space-y-2">
              {llmConfigs.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                        {c.name}
                      </p>
                      {c.is_default_chat && <Badge tone="blue">default</Badge>}
                      {!c.enabled && <Badge tone="slate">disabled</Badge>}
                    </div>
                    <p className="truncate text-[11px] text-slate-400">
                      {c.provider}:{c.model}
                      {c.hasKey ? ` · key ${c.keyMasked}` : ' · no key'}
                      {c.last_tested_at
                        ? ` · tested ${formatDate(c.last_tested_at)} (${c.last_test_ok ? 'ok' : 'failed'})`
                        : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {!c.is_default_chat && (
                      <Button size="sm" variant="ghost" onClick={() => setDefaultChat(c)}>
                        Make default
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setLlmForm({ config: c })}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPendingDelete({ kind: 'llm', config: c })}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Embedding models */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Embedding models
            </h2>
            <Button size="sm" onClick={() => setEmbeddingForm({ config: null })} disabled={!metadata}>
              <PlusIcon className="h-3.5 w-3.5" /> Add model
            </Button>
          </div>
          {embeddingConfigs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500 dark:border-slate-700">
              No embedding models configured. The environment default runs locally with no cloud
              call.
            </p>
          ) : (
            <ul className="space-y-2">
              {embeddingConfigs.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{c.name}</p>
                      {c.is_default && <Badge tone="green">active</Badge>}
                      {!c.enabled && <Badge tone="slate">disabled</Badge>}
                    </div>
                    <p className="truncate text-[11px] text-slate-400">
                      {c.provider}:{c.model} · {c.dimension} dims
                      {c.hasKey ? ` · key ${c.keyMasked}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {!c.is_default && (
                      <Button size="sm" variant="ghost" onClick={() => setDefaultEmbedding(c)}>
                        Make active
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setEmbeddingForm({ config: c })}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPendingDelete({ kind: 'embedding', config: c })}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Preferences */}
        <section className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <SettingsIcon className="h-3.5 w-3.5" /> Preferences
          </h2>
          <div className="space-y-3">
            <Field label="Theme">
              <Select value={theme} onChange={(e) => setTheme(e.target.value)} className="max-w-xs">
                <option value="system">Match system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </Select>
            </Field>
            <label className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={Boolean(settings.cross_project_default)}
                onChange={(e) => updatePreference('cross_project_default', e.target.checked)}
              />
              Enable cross-project search by default
            </label>
            <p className="text-[11px] text-slate-400">
              When off, every question searches only the active project unless you opt in per
              question.
            </p>
          </div>
        </section>
      </div>

      <LlmConfigForm
        open={Boolean(llmForm)}
        onClose={() => {
          setLlmForm(null);
          loadAll();
        }}
        config={llmForm?.config}
        metadata={metadata}
      />
      <EmbeddingConfigForm
        open={Boolean(embeddingForm)}
        onClose={() => {
          setEmbeddingForm(null);
          loadAll();
        }}
        config={embeddingForm?.config}
        metadata={metadata}
      />
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title="Delete configuration"
        confirmLabel="Delete"
        message={
          pendingDelete
            ? `Delete "${pendingDelete.config.name}"? Any key stored with it is removed too. This cannot be undone.`
            : ''
        }
      />
    </div>
  );
}
