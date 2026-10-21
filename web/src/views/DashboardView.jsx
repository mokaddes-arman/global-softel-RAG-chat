import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../store';
import { api } from '../api';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Spinner,
  Textarea,
  statusTone,
  useToast,
} from '../components/ui';
import { BookIcon, ChatIcon, DocIcon, RefreshIcon } from '../components/icons';
import { formatBytes, formatNumber, formatRelative } from '../lib/format';
import { INSTRUCTIONS_MAX_LENGTH, INSTRUCTION_TEMPLATES } from '../lib/persona';

function StatCard({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-0.5 text-xl font-semibold text-slate-800 dark:text-slate-100">{value}</p>
      {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
    </div>
  );
}

function EditProjectModal({ open, onClose, project, onSaved }) {
  const toast = useToast();
  const { updateProject } = useApp();
  const [name, setName] = useState(project?.name || '');
  const [description, setDescription] = useState(project?.description || '');
  const [instructions, setInstructions] = useState(project?.instructions || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(project?.name || '');
      setDescription(project?.description || '');
      setInstructions(project?.instructions || '');
    }
  }, [open, project]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      // Empty instructions are sent as null so the project falls back to the
      // grounded system prompt with no operator persona.
      await updateProject(project.id, {
        name: name.trim(),
        description: description.trim() || null,
        instructions: instructions.trim() || null,
      });
      toast.success('Project updated');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit project"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" required>
          <Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Input value={description} maxLength={4000} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {/* Instructions / persona. Deliberately not wrapped in <Field>: a
            <label> would swallow the template buttons' accessible names. */}
        <div className="space-y-1">
          <span className="block text-xs font-medium text-slate-600 dark:text-slate-300">
            Instructions / persona
          </span>
          <p className="text-xs text-slate-500">
            Optional. Sets the assistant's role and output style for this project. Instructions
            are always subordinate to grounding and citation rules and can never make the
            assistant invent facts.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {INSTRUCTION_TEMPLATES.map((template) => (
              <Button
                key={template.id}
                size="sm"
                variant="outline"
                title={template.description}
                onClick={() => setInstructions(template.text)}
              >
                Load {template.name} persona template
              </Button>
            ))}
          </div>
          <Textarea
            value={instructions}
            rows={10}
            maxLength={INSTRUCTIONS_MAX_LENGTH}
            aria-label="Instructions / persona"
            placeholder="e.g. You are a Senior SQA Engineer. Deliver QA artefacts as grounded, self-contained HTML…"
            onChange={(e) => setInstructions(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
            <span>Loaded templates are a starting point — edit freely.</span>
            <span>
              {instructions.length} / {INSTRUCTIONS_MAX_LENGTH}
            </span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function DashboardView() {
  const { activeProject, setView, setActiveConversationId } = useApp();
  const toast = useToast();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    if (!activeProject) return;
    setLoading(true);
    try {
      const data = await api.projectStats(activeProject.id);
      setStats(data.stats);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeProject, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (!activeProject) {
    return (
      <EmptyState
        icon={<BookIcon className="h-8 w-8 text-slate-400" />}
        title="No project selected"
        description="Select a project to see its dashboard."
      />
    );
  }

  const docs = stats?.documents || {};
  const chunks = stats?.chunks || {};
  const convs = stats?.conversations || {};
  const jobs = stats?.jobs || {};
  const versions = stats?.versions || {};
  const storage = stats?.storage || {};

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
            {activeProject.name}
          </h1>
          <p className="truncate text-[11px] text-slate-400">
            {activeProject.description || 'No description'} · slug {activeProject.slug}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
            <RefreshIcon className="h-3.5 w-3.5" /> Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
            Edit
          </Button>
        </div>
      </header>

      <div className="space-y-6 p-4">
        {loading && !stats ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading dashboard…
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                label="Documents"
                value={formatNumber(docs.total_documents)}
                sub={`${formatNumber(docs.indexed_documents)} indexed · ${formatNumber(docs.processing_documents)} processing`}
              />
              <StatCard
                label="Chunks"
                value={formatNumber(chunks.total_chunks)}
                sub={`${formatNumber(chunks.total_tokens)} tokens`}
              />
              <StatCard
                label="Conversations"
                value={formatNumber(convs.total_conversations)}
                sub={`${formatNumber(convs.recent_conversations)} active this week`}
              />
              <StatCard
                label="Storage"
                value={formatBytes(storage.total_bytes)}
                sub={`${formatNumber(versions.total_versions)} versions`}
              />
            </div>

            {(docs.failed_documents > 0 || jobs.failed_jobs > 0) && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                {formatNumber(docs.failed_documents)} document(s) failed to index ·{' '}
                {formatNumber(jobs.failed_jobs)} failed job(s). Open Documents to retry.
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* Recent uploads */}
              <section className="rounded-lg border border-slate-200 dark:border-slate-800">
                <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
                  <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <DocIcon className="h-3.5 w-3.5" /> Recent documents
                  </h2>
                  <Button size="sm" variant="ghost" onClick={() => setView('documents')}>
                    View all
                  </Button>
                </div>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(stats?.recentUploads || []).length === 0 && (
                    <li className="px-3 py-4 text-sm text-slate-400">No documents yet.</li>
                  )}
                  {(stats?.recentUploads || []).map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-slate-700 dark:text-slate-200" title={d.title}>
                          {d.title}
                        </p>
                        <p className="text-[11px] text-slate-400">
                          {formatBytes(d.size_bytes)} · {formatNumber(d.chunk_count)} chunks ·{' '}
                          {formatRelative(d.created_at)}
                        </p>
                      </div>
                      <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                    </li>
                  ))}
                </ul>
              </section>

              {/* Recent conversations */}
              <section className="rounded-lg border border-slate-200 dark:border-slate-800">
                <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
                  <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <ChatIcon className="h-3.5 w-3.5" /> Recent conversations
                  </h2>
                  <Button size="sm" variant="ghost" onClick={() => setView('chat')}>
                    Open chat
                  </Button>
                </div>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(stats?.recentConversations || []).length === 0 && (
                    <li className="px-3 py-4 text-sm text-slate-400">No conversations yet.</li>
                  )}
                  {(stats?.recentConversations || []).map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveConversationId(c.id);
                          setView('chat');
                        }}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-900/60"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
                          {c.title || 'Untitled'}
                        </span>
                        <span className="text-[11px] text-slate-400">{formatRelative(c.updated_at)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            <section className="rounded-lg border border-slate-200 p-3 text-xs text-slate-500 dark:border-slate-800">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span>Archived documents: {formatNumber(docs.archived_documents)}</span>
                <span>Queued jobs: {formatNumber(jobs.queued_jobs)}</span>
                <span>Running jobs: {formatNumber(jobs.running_jobs)}</span>
              </div>
            </section>
          </>
        )}
      </div>

      <EditProjectModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        project={activeProject}
        onSaved={load}
      />
    </div>
  );
}
