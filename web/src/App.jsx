import { Component, useState } from 'react';
import { useApp } from './store';
import { Sidebar } from './components/Sidebar';
import { Button, EmptyState, Field, Input, Modal } from './components/ui';
import { MenuIcon, PlusIcon, AlertIcon } from './components/icons';
import { ChatView } from './views/ChatView';
import { DocumentsView } from './views/DocumentsView';
import { SearchView } from './views/SearchView';
import { DashboardView } from './views/DashboardView';
import { SettingsView } from './views/SettingsView';
import { ModelUsageView } from './views/ModelUsageView';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            <p className="flex items-center gap-2 font-semibold">
              <AlertIcon className="h-4 w-4" /> Something went wrong in the interface
            </p>
            <p className="mt-1">{this.state.error.message}</p>
            <Button className="mt-3" variant="outline" onClick={() => window.location.reload()}>
              Reload the app
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function FirstProjectScreen() {
  const { createProject } = useApp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const create = async () => {
    if (!name.trim()) {
      setError('Please enter a project name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createProject({ name: name.trim() });
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        icon={<PlusIcon className="h-8 w-8 text-slate-400" />}
        title="Welcome to Global Softel RAG Chat"
        description="Create a project to hold a set of documents, then ask grounded questions and get answers with verifiable citations."
        action={
          <Button onClick={() => setOpen(true)}>
            <PlusIcon className="h-4 w-4" /> Create your first project
          </Button>
        }
      />
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New project"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={create} loading={saving}>
              Create project
            </Button>
          </>
        }
      >
        <Field label="Project name" required error={error}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create();
            }}
            placeholder="e.g. Platform API Specification"
          />
        </Field>
      </Modal>
    </div>
  );
}

function Main() {
  const { view, projects, projectsLoading, sidebarOpen, setSidebarOpen, activeProject } = useApp();

  // Views that make sense with no project at all.
  const globalView = view === 'settings' || view === 'model-usage';
  const showFirstProject = !projectsLoading && projects.length === 0 && !globalView;

  let content;
  if (showFirstProject) content = <FirstProjectScreen />;
  else if (view === 'documents') content = <DocumentsView />;
  else if (view === 'search') content = <SearchView />;
  else if (view === 'dashboard') content = <DashboardView />;
  else if (view === 'model-usage') content = <ModelUsageView />;
  else if (view === 'settings') content = <SettingsView />;
  else content = <ChatView />;

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 lg:hidden dark:border-slate-800 dark:bg-slate-950">
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Open menu"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <span className="truncate text-sm font-semibold">Global Softel RAG</span>
          {activeProject && (
            <span className="truncate text-xs text-slate-400">· {activeProject.name}</span>
          )}
        </div>

        <main className="min-h-0 flex-1">
          <ErrorBoundary>{content}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

export function App() {
  return <Main />;
}
