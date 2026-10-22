import { useMemo, useState } from 'react';
import { useApp } from '../store';
import { api } from '../api';
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  cn,
  useToast,
} from './ui';
import {
  ArchiveIcon,
  ChatIcon,
  ChartIcon,
  ChevronIcon,
  DocIcon,
  MenuIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  TrashIcon,
  BookIcon,
} from './icons';
import { formatNumber, formatRelative } from '../lib/format';

const NAV = [
  { id: 'chat', label: 'Chat', icon: ChatIcon },
  { id: 'documents', label: 'Documents', icon: DocIcon },
  { id: 'search', label: 'Search', icon: SearchIcon },
  { id: 'dashboard', label: 'Dashboard', icon: BookIcon },
  { id: 'model-usage', label: 'Model usage', icon: ChartIcon },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

// Views that are not tied to a single project and stay available without one.
const GLOBAL_VIEWS = ['settings', 'model-usage'];

function NewProjectModal({ open, onClose }) {
  const { createProject } = useApp();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const close = () => {
    setName('');
    setDescription('');
    setError(null);
    onClose();
  };

  const submit = async () => {
    if (!name.trim()) {
      setError('Please enter a project name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createProject({ name: name.trim(), description: description.trim() || null });
      toast.success('Project created');
      close();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="New project"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving}>
            Create project
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required error={error}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Platform API Specification"
            maxLength={200}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </Field>
        <Field label="Description" hint="Optional. What documentation lives in this project?">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            maxLength={4000}
          />
        </Field>
        <p className="rounded-md bg-slate-50 p-2 text-xs text-slate-500 dark:bg-slate-800/60">
          Answers are scoped to this project only. Cross-project search stays off unless you
          explicitly enable it per question.
        </p>
      </div>
    </Modal>
  );
}

function ConversationList() {
  const {
    conversations,
    conversationsLoading,
    activeConversationId,
    setActiveConversationId,
    activeProject,
    refreshConversations,
  } = useApp();
  const toast = useToast();
  const [pendingDelete, setPendingDelete] = useState(null);
  const [busy, setBusy] = useState(false);

  // Start a fresh chat locally. The conversation row is created when the first
  // question is sent, so an unused "New conversation" never litters the list
  // and the title is derived from that first question.
  const startNew = () => {
    if (!activeProject) return;
    setActiveConversationId(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await api.deleteConversation(pendingDelete.id);
      if (activeConversationId === pendingDelete.id) setActiveConversationId(null);
      await refreshConversations();
      toast.success('Conversation deleted');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Conversations
        </span>
        <button
          type="button"
          onClick={startNew}
          disabled={!activeProject}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40 dark:hover:bg-slate-800"
          title="New conversation"
          aria-label="New conversation"
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
        {conversationsLoading && !conversations.length && (
          <p className="px-1 py-2 text-xs text-slate-400">Loading…</p>
        )}
        {!conversationsLoading && !conversations.length && (
          <p className="px-1 py-2 text-xs text-slate-400">
            No conversations yet. Start one above.
          </p>
        )}
        {conversations.map((c) => {
          const active = c.id === activeConversationId;
          return (
            <div
              key={c.id}
              className={cn(
                'group flex items-center gap-1 rounded-md px-2 py-1.5 text-left',
                active
                  ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-200'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
              )}
            >
              <button
                type="button"
                onClick={() => setActiveConversationId(c.id)}
                className="min-w-0 flex-1 text-left"
                title={c.title}
              >
                <span className="block truncate text-sm">{c.title || 'Untitled'}</span>
                <span className="block truncate text-[11px] text-slate-400">
                  {formatRelative(c.updated_at)}
                  {c.message_count ? ` · ${c.message_count} msg` : ''}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPendingDelete(c)}
                className="rounded p-1 text-slate-400 opacity-0 hover:bg-red-100 hover:text-red-600 group-hover:opacity-100 dark:hover:bg-red-900/40"
                title="Delete conversation"
                aria-label={`Delete ${c.title || 'conversation'}`}
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        loading={busy}
        title="Delete conversation"
        confirmLabel="Delete"
        message={`Delete "${pendingDelete?.title || 'this conversation'}" and all of its messages? This cannot be undone.`}
      />
    </div>
  );
}

function SystemFooter() {
  const { systemStatus, setView } = useApp();
  if (!systemStatus) return null;
  const counts = systemStatus.counts || {};
  const jobs = counts.active_jobs || 0;
  return (
    <div className="border-t border-slate-200 px-3 py-2 text-[11px] text-slate-500 dark:border-slate-700">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{formatNumber(counts.projects)} projects</span>
        <span>{formatNumber(counts.documents)} docs</span>
        <span>{formatNumber(counts.chunks)} chunks</span>
        {jobs > 0 && (
          <Badge tone="amber" className="!text-[10px]">
            {jobs} indexing
          </Badge>
        )}
      </div>
      {systemStatus.hostedAi?.disabled && (
        <p className="mt-1 text-amber-600 dark:text-amber-400">Hosted AI answers are disabled.</p>
      )}
      {systemStatus.embeddings?.needsReindex && (
        <button
          type="button"
          onClick={() => setView('settings')}
          className="mt-1 text-amber-600 underline dark:text-amber-400"
        >
          {systemStatus.embeddings.staleChunks} chunks need re-indexing
        </button>
      )}
    </div>
  );
}

export function Sidebar() {
  const {
    projects,
    projectsLoading,
    activeProject,
    activeProjectId,
    selectProject,
    view,
    setView,
    theme,
    setTheme,
    sidebarOpen,
    setSidebarOpen,
    archiveProject,
    refreshProjects,
  } = useApp();
  const toast = useToast();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );

  const dark = theme === 'dark' || (theme === 'system' && document.documentElement.classList.contains('dark'));
  const toggleTheme = () => setTheme(dark ? 'light' : 'dark');

  const doArchive = async () => {
    if (!activeProject) return;
    setArchiving(true);
    try {
      await archiveProject(activeProject.id);
      toast.success('Project archived');
      setConfirmArchive(false);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setArchiving(false);
    }
  };

  return (
    <>
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-slate-200 bg-white transition-transform dark:border-slate-800 dark:bg-slate-950 lg:static lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Identity */}
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-3 dark:border-slate-800">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-sm font-bold text-white">
            GS
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
              Global Softel RAG
            </p>
            <p className="truncate text-[11px] text-slate-400">Grounded documentation chat</p>
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
            title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label="Toggle theme"
          >
            {dark ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 lg:hidden dark:hover:bg-slate-800"
            aria-label="Close menu"
          >
            <ChevronIcon className="h-4 w-4 rotate-90" />
          </button>
        </div>

        {/* Project selector */}
        <div className="space-y-2 border-b border-slate-200 px-3 py-3 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Project
            </span>
            <button
              type="button"
              onClick={() => setNewProjectOpen(true)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
            >
              <PlusIcon className="h-3 w-3" /> New
            </button>
          </div>
          {projectsLoading && !projects.length ? (
            <p className="text-xs text-slate-400">Loading projects…</p>
          ) : projects.length ? (
            <select
              value={activeProjectId || ''}
              onChange={(e) => selectProject(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              {sortedProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <button
              type="button"
              onClick={() => setNewProjectOpen(true)}
              className="w-full rounded-md border border-dashed border-slate-300 px-2 py-2 text-xs text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
            >
              Create your first project
            </button>
          )}
        </div>

        {/* Navigation */}
        <nav className="space-y-0.5 px-2 py-2">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setView(item.id);
                  setSidebarOpen(false);
                }}
                disabled={!activeProject && item.id !== 'settings' && item.id !== 'model-usage'}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium disabled:opacity-40',
                  active
                    ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Conversations (chat view only) */}
        {view === 'chat' && activeProject && (
          <div className="flex min-h-0 flex-1 flex-col border-t border-slate-200 px-2 py-2 dark:border-slate-800">
            <ConversationList />
          </div>
        )}

        {/* Project actions */}
        {activeProject && view !== 'chat' && (
          <div className="flex-1 px-3 py-3">
            <div className="relative">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMenuOpen((v) => !v)}
                className="!justify-start"
              >
                <ChevronIcon className={cn('h-3.5 w-3.5 transition-transform', menuOpen && 'rotate-180')} />
                Project actions
              </Button>
              {menuOpen && (
                <div className="mt-1 space-y-1 rounded-md border border-slate-200 p-1 dark:border-slate-700">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirmArchive(true);
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    <ArchiveIcon className="h-3.5 w-3.5" /> Archive project
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      setView('settings');
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    <SettingsIcon className="h-3.5 w-3.5" /> Project settings
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {!activeProject && <div className="flex-1" />}

        <SystemFooter />
      </aside>

      <NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
      <ConfirmDialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        onConfirm={doArchive}
        loading={archiving}
        danger={false}
        title="Archive project"
        confirmLabel="Archive"
        message={`Archive "${activeProject?.name}"? Its documents and history are kept but it leaves the active project list.`}
      />
      <button type="button" className="hidden" onClick={refreshProjects} aria-hidden="true" />
    </>
  );
}
