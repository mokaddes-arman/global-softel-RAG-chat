import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useAsk } from '../store';
import { api } from '../api';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Modal,
  Spinner,
  Textarea,
  cn,
  useToast,
} from '../components/ui';
import {
  AlertIcon,
  ChatIcon,
  CopyIcon,
  RefreshIcon,
  SearchIcon,
  SendIcon,
  StopIcon,
  TrashIcon,
} from '../components/icons';
import { Markdown } from '../components/Markdown';
import { SourceList } from '../components/SourceList';
import { groupSourcesByMessage } from '../lib/sources';
import { formatDuration } from '../lib/format';

const LIVE_ID = '__streaming__';

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function MessageSources({ sources }) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
      >
        <SearchIcon className="h-3.5 w-3.5" />
        {open ? 'Hide' : 'Show'} {sources.length} source{sources.length === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="mt-2">
          <SourceList sources={sources} />
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message, sources, onRetry, streaming = false }) {
  const toast = useToast();
  const isUser = message.role === 'user';
  const failed = message.status === 'error' || message.status === 'aborted';
  const noEvidence = message.retrieval_meta?.noEvidence;

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2 text-sm text-white whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[95%]">
        <div
          className={cn(
            'rounded-2xl rounded-bl-sm border px-4 py-3',
            failed
              ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40'
              : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900',
          )}
        >
          <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-400">
            {failed ? (
              <>
                <AlertIcon className="h-3.5 w-3.5 text-red-500" />
                <span className="text-red-600 dark:text-red-400">
                  {message.status === 'aborted' ? 'Stopped' : 'Generation failed'}
                </span>
              </>
            ) : (
              <span>Assistant</span>
            )}
            {message.model && <span>· {message.model}</span>}
            {Number.isFinite(message.latency_ms) && <span>· {formatDuration(message.latency_ms)}</span>}
          </div>

          {message.content ? (
            <Markdown>{message.content}</Markdown>
          ) : streaming ? (
            <span className="inline-flex items-center gap-2 text-sm text-slate-400">
              <Spinner className="h-3.5 w-3.5" /> Thinking…
            </span>
          ) : null}

          {noEvidence && (
            <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              The knowledge base did not contain enough evidence to answer, so the assistant
              abstained instead of guessing.
            </p>
          )}

          <MessageSources sources={sources} />

          {!streaming && (
            <div className="mt-2 flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const ok = await copyText(message.content || '');
                  if (ok) toast.success('Answer copied');
                  else toast.error('Could not access the clipboard');
                }}
              >
                <CopyIcon className="h-3.5 w-3.5" /> Copy
              </Button>
              {onRetry && (
                <Button size="sm" variant="ghost" onClick={onRetry}>
                  <RefreshIcon className="h-3.5 w-3.5" /> Retry
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Composer({ onSend, onStop, streaming, disabled }) {
  const [text, setText] = useState('');
  const ref = useRef(null);

  const send = () => {
    const value = text.trim();
    if (!value || streaming || disabled) return;
    setText('');
    onSend(value);
    ref.current?.focus();
  };

  return (
    <div className="border-t border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-end gap-2">
        <Textarea
          ref={ref}
          rows={2}
          value={text}
          disabled={disabled}
          placeholder={disabled ? 'Select or create a project first.' : 'Ask a question about this project’s documents…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          className="!resize-none"
        />
        {streaming ? (
          <Button variant="danger" size="lg" onClick={onStop}>
            <StopIcon className="h-4 w-4" /> Stop
          </Button>
        ) : (
          <Button size="lg" onClick={send} disabled={disabled || !text.trim()}>
            <SendIcon className="h-4 w-4" /> Send
          </Button>
        )}
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        Enter to send · Shift+Enter for a new line · answers are grounded in retrieved excerpts
        only.
      </p>
    </div>
  );
}

function EvidenceModal({ open, onClose, conversationId, defaultQuestion }) {
  const { activeProject } = useApp();
  const [question, setQuestion] = useState(defaultQuestion || '');
  const [crossProject, setCrossProject] = useState(false);
  const [includeHistorical, setIncludeHistorical] = useState(false);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setQuestion(defaultQuestion || '');
      setResult(null);
      setError(null);
    }
  }, [open, defaultQuestion]);

  const run = async () => {
    if (!question.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.evidence(conversationId, {
        question: question.trim(),
        crossProject,
        retrieval: { includeHistoricalVersions: includeHistorical },
      });
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const stats = result?.stats;

  return (
    <Modal open={open} onClose={onClose} title="Inspect evidence" wide>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Runs retrieval without calling the language model, so you can see exactly what the
          assistant would be allowed to use.
        </p>
        <div className="flex items-end gap-2">
          <Field label="Question" className="flex-1">
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What do the documents say about…"
              onKeyDown={(e) => {
                if (e.key === 'Enter') run();
              }}
            />
          </Field>
          <Button onClick={run} loading={loading} disabled={!question.trim()}>
            Retrieve
          </Button>
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-slate-600 dark:text-slate-300">
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={crossProject} onChange={(e) => setCrossProject(e.target.checked)} />
            Search all active projects
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={includeHistorical}
              onChange={(e) => setIncludeHistorical(e.target.checked)}
            />
            Include historical versions
          </label>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {stats && (
          <div className="flex flex-wrap gap-3 text-[11px] text-slate-500">
            <span>returned {stats.returned ?? 0}</span>
            <span>vector {stats.vectorCount ?? 0}</span>
            <span>keyword {stats.keywordCount ?? 0}</span>
            {stats.reason && <span className="text-amber-600 dark:text-amber-400">reason: {stats.reason}</span>}
          </div>
        )}
        {result && (
          <div className="max-h-[45vh] overflow-y-auto">
            <SourceList
              sources={result.sources || []}
              emptyText={
                stats?.reason === 'no_projects'
                  ? 'No indexed documents were found in scope. Upload and index a document first.'
                  : 'No relevant passages were retrieved for this question.'
              }
            />
          </div>
        )}
      </div>
      {!activeProject && <p className="text-xs text-slate-400">No active project.</p>}
    </Modal>
  );
}

function RenameModal({ open, onClose, conversation, onRenamed }) {
  const [title, setTitle] = useState(conversation?.title || '');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (open) setTitle(conversation?.title || '');
  }, [open, conversation]);

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await api.updateConversation(conversation.id, { title: title.trim() });
      toast.success('Conversation renamed');
      onRenamed();
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
      title="Rename conversation"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!title.trim()}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Title">
        <Input
          autoFocus
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
        />
      </Field>
    </Modal>
  );
}

export function ChatView() {
  const {
    activeProject,
    activeConversationId,
    setActiveConversationId,
    refreshConversations,
    conversations,
  } = useApp();
  const {
    messages,
    messageSources,
    messagesLoading,
    messagesError,
    ask,
    askQuestion,
    stopAsk,
  } = useAsk();
  const toast = useToast();

  const [crossProject, setCrossProject] = useState(false);
  const [allowUngrounded, setAllowUngrounded] = useState(false);
  const [llmConfigs, setLlmConfigs] = useState([]);
  const [llmConfigId, setLlmConfigId] = useState('');

  const [renameOpen, setRenameOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const bottomRef = useRef(null);

  // Only the ask belonging to the conversation on screen is shown inline. A
  // generation that is running for another conversation keeps going in the
  // background; switching back to it shows the live buffer again.
  const activeAsk = ask && ask.conversationId === activeConversationId ? ask : null;
  const streaming = Boolean(ask?.streaming);

  const pendingQuestion = activeAsk?.question || null;
  const pendingContent = activeAsk?.content || '';
  const pendingSources = activeAsk?.sources || [];
  const pendingStatus = activeAsk?.status || null;
  const pendingStats = activeAsk?.stats || null;

  const conversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) || null,
    [conversations, activeConversationId],
  );

  const sourcesByMessage = useMemo(() => groupSourcesByMessage(messageSources), [messageSources]);

  useEffect(() => {
    api
      .listLlmConfigs()
      .then((data) => setLlmConfigs(data.configs || []))
      .catch(() => setLlmConfigs([]));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, pendingContent, pendingQuestion]);

  const runAsk = useCallback(
    (question) => askQuestion({ question, crossProject, allowUngrounded, llmConfigId }),
    [askQuestion, crossProject, allowUngrounded, llmConfigId],
  );

  const stop = stopAsk;

  const retryFrom = (messageId) => {
    const index = messages.findIndex((m) => m.id === messageId);
    for (let i = index - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        runAsk(messages[i].content);
        return;
      }
    }
  };

  const lastUserQuestion = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'user')?.content || '',
    [messages],
  );

  const deleteConversation = async () => {
    if (!conversation) return;
    setDeleting(true);
    try {
      await api.deleteConversation(conversation.id);
      setActiveConversationId(null);
      await refreshConversations();
      toast.success('Conversation deleted');
      setConfirmDelete(false);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  };

  if (!activeProject) {
    return (
      <EmptyState
        icon={<ChatIcon className="h-8 w-8 text-slate-400" />}
        title="No project selected"
        description="Create or select a project in the sidebar to start chatting with its documents."
      />
    );
  }

  const showEmptyState = !activeConversationId && !pendingQuestion && !messagesLoading;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
              {conversation?.title || 'New conversation'}
            </h1>
            {conversation?.provider && (
              <Badge tone="slate">
                {conversation.provider}
                {conversation.model ? `:${conversation.model}` : ''}
              </Badge>
            )}
          </div>
          <p className="truncate text-[11px] text-slate-400">
            {activeProject.name}
            {crossProject ? ' · cross-project search on' : ' · this project only'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {activeConversationId && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setRenameOpen(true)}>
                Rename
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                <TrashIcon className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" onClick={() => setEvidenceOpen(true)} disabled={!activeConversationId}>
            <SearchIcon className="h-3.5 w-3.5" /> Evidence
          </Button>
        </div>
      </header>

      {/* Messages */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messagesError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            Could not load this conversation: {messagesError.message}
          </div>
        )}

        {showEmptyState && (
          <EmptyState
            icon={<ChatIcon className="h-8 w-8 text-slate-400" />}
            title="Ask a question about this project"
            description={`Answers are grounded in the indexed documents of "${activeProject.name}". Ask something, and the assistant will cite the exact sources it used — or abstain if the documents do not cover it.`}
          />
        )}

        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            sources={sourcesByMessage.get(message.id) || []}
            onRetry={
              message.role === 'assistant' && !streaming
                ? () => retryFrom(message.id)
                : undefined
            }
          />
        ))}

        {/* In-flight exchange (kept separate from persisted messages) */}
        {pendingQuestion && (
          <MessageBubble message={{ id: 'pending-user', role: 'user', content: pendingQuestion }} />
        )}
        {pendingQuestion && (
          <div>
            <MessageBubble
              message={{
                id: LIVE_ID,
                role: 'assistant',
                content: pendingContent,
                status: 'streaming',
                model: conversation?.model,
              }}
              sources={pendingSources}
              streaming
            />
            {pendingStatus && !pendingContent && (
              <p className="mt-1 text-xs text-slate-400">{pendingStatus.message}</p>
            )}
            {pendingStats && (
              <p className="mt-1 text-[11px] text-slate-400">
                retrieved {pendingStats.returned ?? 0} of {pendingStats.fusedCount ?? 0} candidates
                {pendingStats.reason ? ` · ${pendingStats.reason}` : ''}
              </p>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Options + composer */}
      <div className="border-t border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/60">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-600 dark:text-slate-300">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={crossProject}
              onChange={(e) => setCrossProject(e.target.checked)}
            />
            Cross-project search
          </label>
          <label className="inline-flex items-center gap-1.5" title="Bypass the grounding requirement (not recommended)">
            <input
              type="checkbox"
              checked={allowUngrounded}
              onChange={(e) => setAllowUngrounded(e.target.checked)}
            />
            Allow answer without evidence
          </label>
          {llmConfigs.length > 0 && (
            <label className="inline-flex items-center gap-1.5">
              Provider
              <select
                value={llmConfigId}
                onChange={(e) => setLlmConfigId(e.target.value)}
                disabled={streaming}
                className="rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-900"
              >
                <option value="">Default</option>
                {llmConfigs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.is_default_chat ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {ask?.streaming && ask.conversationId !== activeConversationId && (
            <span className="text-[11px] text-amber-600 dark:text-amber-400">
              An answer is still being generated in another conversation…
            </span>
          )}
        </div>
      </div>

      <Composer onSend={runAsk} onStop={stop} streaming={streaming} disabled={false} />

      <RenameModal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        conversation={conversation}
        onRenamed={refreshConversations}
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={deleteConversation}
        loading={deleting}
        title="Delete conversation"
        confirmLabel="Delete"
        message={`Delete "${conversation?.title || 'this conversation'}" and all of its messages? This cannot be undone.`}
      />
      <EvidenceModal
        open={evidenceOpen}
        onClose={() => setEvidenceOpen(false)}
        conversationId={activeConversationId}
        defaultQuestion={lastUserQuestion}
      />
    </div>
  );
}
