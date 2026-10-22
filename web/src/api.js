// Thin API client for the Global Softel RAG Chat backend.
// The dev server proxies /api to the backend, so a relative base always works.

const BASE = '/api';

function qs(params = {}) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    usp.append(key, String(value));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

async function parse(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export class ApiError extends Error {
  constructor(message, { status, code, details, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, headers, signal } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      accept: 'application/json',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await parse(res);
  if (!res.ok) {
    throw new ApiError(data?.error?.message || `Request failed (${res.status})`, {
      status: res.status,
      code: data?.error?.code,
      details: data?.error?.details,
      body: data,
    });
  }
  return data;
}

/** Upload one or more files as multipart (not JSON). Returns the raw body. */
async function upload(path, fileOrFiles) {
  const fd = new FormData();
  const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  for (const f of files) fd.append('files', f);
  const res = await fetch(BASE + path, { method: 'POST', body: fd });
  const data = await parse(res);
  return { status: res.status, ok: res.ok, body: data };
}

export const api = {
  // --- system -----------------------------------------------------------------
  health: () => request('/health'),
  systemStatus: () => request('/system/status'),
  getSettings: () => request('/settings'),
  updateSetting: (key, value) => request(`/settings/${key}`, { method: 'PUT', body: { value } }),
  embeddingIndex: () => request('/settings/embedding-index'),
  providerMetadata: () => request('/providers/metadata'),

  // --- projects ---------------------------------------------------------------
  listProjects: (includeArchived = false) =>
    request(`/projects${includeArchived ? '?includeArchived=true' : ''}`),
  createProject: (body) => request('/projects', { method: 'POST', body }),
  getProject: (id) => request(`/projects/${id}`),
  updateProject: (id, body) => request(`/projects/${id}`, { method: 'PATCH', body }),
  archiveProject: (id) => request(`/projects/${id}/archive`, { method: 'POST' }),
  restoreProject: (id) => request(`/projects/${id}/restore`, { method: 'POST' }),
  deleteProject: (id) => request(`/projects/${id}?confirm=yes`, { method: 'DELETE' }),
  projectStats: (id) => request(`/projects/${id}/stats`),
  projectDocuments: (id, params) => request(`/projects/${id}/documents${qs(params)}`),
  projectConversations: (id, params) => request(`/projects/${id}/conversations${qs(params)}`),
  projectJobs: (id, params) => request(`/projects/${id}/jobs${qs(params)}`),
  projectSearch: (id, params) => request(`/projects/${id}/search${qs(params)}`),

  // --- documents --------------------------------------------------------------
  uploadFiles: (projectId, files, onDuplicate) =>
    upload(`/projects/${projectId}/documents/upload${qs({ onDuplicate })}`, files),
  addVersion: (documentId, file) => upload(`/documents/${documentId}/versions`, file),
  getDocument: (id) => request(`/documents/${id}`),
  deleteDocument: (id, permanent = false) =>
    request(`/documents/${id}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' }),
  restoreDocument: (id) => request(`/documents/${id}/restore`, { method: 'POST' }),
  reindexDocument: (id, versionId) =>
    request(`/documents/${id}/reindex`, { method: 'POST', body: versionId ? { versionId } : {} }),
  activateVersion: (id, versionId) =>
    request(`/documents/${id}/activate-version`, { method: 'POST', body: { versionId } }),
  retryJob: (jobId) => request(`/jobs/${jobId}/retry`, { method: 'POST' }),
  getChunk: (id) => request(`/chunks/${id}`),
  fileUrl: (id, { versionId, download } = {}) =>
    `${BASE}/documents/${id}/file${qs({ versionId, download: download ? 'true' : undefined })}`,
  /** The shared `.md` representation of a document (JSON preview). */
  documentMarkdown: (id, { versionId } = {}) => request(`/documents/${id}/markdown${qs({ versionId })}`),
  /** Direct link to the shared `.md` file (used by the download icon). */
  documentMarkdownUrl: (id, { versionId } = {}) =>
    `${BASE}/documents/${id}/markdown/download${qs({ versionId })}`,

  // --- knowledge base ---------------------------------------------------------
  // Web links: a URL that is crawled into the knowledge base as a document.
  listWebLinks: (projectId, params) => request(`/projects/${projectId}/links${qs(params)}`),
  createWebLinks: (projectId, body) => request(`/projects/${projectId}/links`, { method: 'POST', body }),
  getWebLink: (id) => request(`/links/${id}`),
  updateWebLink: (id, body) => request(`/links/${id}`, { method: 'PATCH', body }),
  deleteWebLink: (id) => request(`/links/${id}`, { method: 'DELETE' }),
  /** Queue a fresh crawl of a link (re-crawl). */
  crawlWebLink: (id) => request(`/links/${id}/crawl`, { method: 'POST' }),

  // Link lists: a named list of URLs that can be imported into the knowledge base.
  listLinkLists: (projectId) => request(`/projects/${projectId}/link-lists`),
  createLinkList: (projectId, body) => request(`/projects/${projectId}/link-lists`, { method: 'POST', body }),
  getLinkList: (id) => request(`/link-lists/${id}`),
  addLinkListItems: (id, urls) => request(`/link-lists/${id}/items`, { method: 'POST', body: { urls } }),
  deleteLinkList: (id) => request(`/link-lists/${id}`, { method: 'DELETE' }),
  /** Turn every URL of a list into a knowledge-base link and crawl it. */
  importLinkList: (id, collectionId) =>
    request(`/link-lists/${id}/import`, { method: 'POST', body: { collectionId: collectionId || null } }),

  // Collections: named groups of documents and web links.
  listCollections: (projectId) => request(`/projects/${projectId}/collections`),
  createCollection: (projectId, body) => request(`/projects/${projectId}/collections`, { method: 'POST', body }),
  getCollection: (id) => request(`/collections/${id}`),
  updateCollection: (id, body) => request(`/collections/${id}`, { method: 'PATCH', body }),
  deleteCollection: (id) => request(`/collections/${id}`, { method: 'DELETE' }),
  addCollectionItems: (id, body) => request(`/collections/${id}/items`, { method: 'POST', body }),
  removeCollectionItem: (id, itemId) => request(`/collections/${id}/items/${itemId}`, { method: 'DELETE' }),

  // Crawl jobs: the queue that fetches and indexes the linked pages.
  listCrawlJobs: (projectId, params) => request(`/projects/${projectId}/crawl-jobs${qs(params)}`),
  retryCrawlJob: (id) => request(`/crawl-jobs/${id}/retry`, { method: 'POST' }),

  // --- conversations ----------------------------------------------------------
  createConversation: (projectId, body = {}) =>
    request(`/projects/${projectId}/conversations`, { method: 'POST', body }),
  getConversation: (id) => request(`/conversations/${id}`),
  updateConversation: (id, body) => request(`/conversations/${id}`, { method: 'PATCH', body }),
  deleteConversation: (id) => request(`/conversations/${id}`, { method: 'DELETE' }),
  conversationMessages: (id) => request(`/conversations/${id}/messages`),
  evidence: (id, body) => request(`/conversations/${id}/evidence`, { method: 'POST', body }),

  // --- providers --------------------------------------------------------------
  listLlmConfigs: () => request('/providers/llm'),
  createLlmConfig: (body) => request('/providers/llm', { method: 'POST', body }),
  updateLlmConfig: (id, body) => request(`/providers/llm/${id}`, { method: 'PATCH', body }),
  deleteLlmConfig: (id) => request(`/providers/llm/${id}`, { method: 'DELETE' }),
  testLlmConfig: (id) => request(`/providers/llm/${id}/test`, { method: 'POST' }),
  testLlmAdHoc: (body) => request('/providers/llm/test', { method: 'POST', body }),
  setDefaultChat: (id) => request(`/providers/llm/${id}/default`, { method: 'POST' }),

  listEmbeddingConfigs: () => request('/providers/embedding'),
  createEmbeddingConfig: (body) => request('/providers/embedding', { method: 'POST', body }),
  updateEmbeddingConfig: (id, body) =>
    request(`/providers/embedding/${id}`, { method: 'PATCH', body }),
  deleteEmbeddingConfig: (id) => request(`/providers/embedding/${id}`, { method: 'DELETE' }),
  setDefaultEmbedding: (id) => request(`/providers/embedding/${id}/default`, { method: 'POST' }),

  // --- model usage ------------------------------------------------------------
  modelUsage: (params) => request(`/model-usage${qs(params)}`),
  modelUsageCatalog: () => request('/model-usage/catalog'),
};

/**
 * Ask a question and consume the Server-Sent Events stream.
 * `onEvent` receives each decoded event object. Returns the final 'done'/'error'
 * event so callers can react to completion.
 *
 * Two watchdogs protect the browser: if the server stops sending events for
 * `idleTimeoutMs`, or the whole exchange takes longer than `overallTimeoutMs`,
 * the request is aborted and an error is raised instead of leaving the UI on
 * a spinner forever. A stream that ends without a terminal event is also
 * reported as an error.
 */
export async function askStream(
  conversationId,
  body,
  { onEvent, signal, idleTimeoutMs = 120000, overallTimeoutMs = 300000 } = {},
) {
  const controller = new AbortController();
  const abortWith = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onOuterAbort = () => abortWith(new Error('cancelled'));
  if (signal) {
    if (signal.aborted) abortWith(new Error('cancelled'));
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let timeoutReason = null;
  let idleTimer = null;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timeoutReason = `The server stopped responding for ${Math.round(idleTimeoutMs / 1000)}s.`;
      abortWith(new Error('idle timeout'));
    }, idleTimeoutMs);
  };
  const overallTimer = setTimeout(() => {
    timeoutReason = `The answer took longer than ${Math.round(overallTimeoutMs / 1000)}s.`;
    abortWith(new Error('overall timeout'));
  }, overallTimeoutMs);

  try {
    const res = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const data = await parse(res);
      throw new ApiError(data?.error?.message || `Request failed (${res.status})`, {
        status: res.status,
        code: data?.error?.code,
        details: data?.error?.details,
        body: data,
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let last = null;
    let finished = false;

    armIdleTimer();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        armIdleTimer();
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          try {
            const event = JSON.parse(json);
            last = event;
            if (event.type === 'done' || event.type === 'error' || event.type === 'complete') finished = true;
            onEvent?.(event);
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    } catch (err) {
      if (timeoutReason) {
        throw new ApiError(timeoutReason, { code: 'client_timeout', status: 504 });
      }
      if (signal?.aborted) throw err;
      throw new ApiError(err.message || 'The connection to the server was lost.', {
        code: 'stream_error',
        status: 502,
      });
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        /* already released */
      }
    }

    if (!finished && !timeoutReason) {
      throw new ApiError('The server closed the connection before the answer was finished.', {
        code: 'incomplete_stream',
        status: 502,
      });
    }
    return last;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(overallTimer);
    if (signal) signal.removeEventListener?.('abort', onOuterAbort);
  }
}

export { qs };
