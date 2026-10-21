import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api } from './api';

/**
 * A single small store for cross-cutting UI state: which project is active,
 * which conversation is open, theme, and the cached system status. Views fetch
 * their own detailed data; this keeps the shared state minimal and avoids
 * prop-drilling through the shell.
 */

const AppContext = createContext(null);

const THEME_KEY = 'rag.theme';
const PROJECT_KEY = 'rag.activeProjectId';

function prefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'system' && prefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

export function AppProvider({ children }) {
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState(null);

  const [activeProjectId, setActiveProjectIdState] = useState(
    () => localStorage.getItem(PROJECT_KEY) || null,
  );

  const [theme, setThemeState] = useState(() => localStorage.getItem(THEME_KEY) || 'system');
  const [view, setView] = useState('chat');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [systemStatus, setSystemStatus] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState(null);

  // --- theme -----------------------------------------------------------------
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return undefined;
    const handler = () => {
      if (theme === 'system') applyTheme('system');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((next) => {
    setThemeState(next);
    // Best-effort persistence server-side; the UI does not depend on it.
    api.updateSetting('ui_theme', next).catch(() => {});
  }, []);

  // --- projects --------------------------------------------------------------
  const refreshProjects = useCallback(async ({ includeArchived = false } = {}) => {
    setProjectsLoading(true);
    try {
      const data = await api.listProjects(includeArchived);
      const list = data.projects || [];
      setProjects(list);
      setProjectsError(null);
      return list;
    } catch (err) {
      setProjectsError(err);
      throw err;
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshProjects().catch(() => {});
  }, [refreshProjects]);

  // Keep the active project valid as the list changes. Wait until the list has
  // actually loaded, otherwise a page reload would clear the persisted choice
  // (projects=[] on first render) and silently fall back to the first project.
  useEffect(() => {
    if (projectsLoading) return;
    if (!projects.length) {
      if (activeProjectId) {
        setActiveProjectIdState(null);
        localStorage.removeItem(PROJECT_KEY);
      }
      return;
    }
    if (!projects.some((p) => p.id === activeProjectId)) {
      const first = projects[0].id;
      setActiveProjectIdState(first);
      localStorage.setItem(PROJECT_KEY, first);
    }
  }, [projects, activeProjectId, projectsLoading]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) || null,
    [projects, activeProjectId],
  );

  const selectProject = useCallback((id) => {
    setActiveProjectIdState(id || null);
    if (id) localStorage.setItem(PROJECT_KEY, id);
    else localStorage.removeItem(PROJECT_KEY);
    setActiveConversationId(null);
    setConversations([]);
    setView('chat');
    setSidebarOpen(false);
  }, []);

  const createProject = useCallback(
    async (body) => {
      const data = await api.createProject(body);
      await refreshProjects();
      if (data?.project?.id) selectProject(data.project.id);
      return data.project;
    },
    [refreshProjects, selectProject],
  );

  const updateProject = useCallback(
    async (id, patch) => {
      const data = await api.updateProject(id, patch);
      await refreshProjects();
      return data.project;
    },
    [refreshProjects],
  );

  const archiveProject = useCallback(
    async (id) => {
      await api.archiveProject(id);
      await refreshProjects();
    },
    [refreshProjects],
  );

  const removeProject = useCallback(
    async (id) => {
      await api.deleteProject(id);
      if (activeProjectId === id) selectProject(null);
      await refreshProjects();
    },
    [activeProjectId, refreshProjects, selectProject],
  );

  // --- conversations ---------------------------------------------------------
  const refreshConversations = useCallback(async () => {
    if (!activeProjectId) {
      setConversations([]);
      return [];
    }
    setConversationsLoading(true);
    try {
      const data = await api.projectConversations(activeProjectId, { limit: 200 });
      const list = data.conversations || [];
      setConversations(list);
      return list;
    } catch {
      return [];
    } finally {
      setConversationsLoading(false);
    }
  }, [activeProjectId]);

  useEffect(() => {
    setActiveConversationId(null);
    refreshConversations();
  }, [activeProjectId, refreshConversations]);

  // --- system status ---------------------------------------------------------
  const refreshSystemStatus = useCallback(async () => {
    try {
      const status = await api.systemStatus();
      setSystemStatus(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    refreshSystemStatus();
    const timer = window.setInterval(refreshSystemStatus, 20_000);
    return () => window.clearInterval(timer);
  }, [refreshSystemStatus]);

  const value = useMemo(
    () => ({
      projects,
      projectsLoading,
      projectsError,
      refreshProjects,
      activeProject,
      activeProjectId,
      selectProject,
      createProject,
      updateProject,
      archiveProject,
      removeProject,
      conversations,
      conversationsLoading,
      refreshConversations,
      activeConversationId,
      setActiveConversationId,
      theme,
      setTheme,
      view,
      setView,
      sidebarOpen,
      setSidebarOpen,
      systemStatus,
      refreshSystemStatus,
    }),
    [
      projects,
      projectsLoading,
      projectsError,
      refreshProjects,
      activeProject,
      activeProjectId,
      selectProject,
      createProject,
      updateProject,
      archiveProject,
      removeProject,
      conversations,
      conversationsLoading,
      refreshConversations,
      activeConversationId,
      theme,
      setTheme,
      view,
      sidebarOpen,
      systemStatus,
      refreshSystemStatus,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
