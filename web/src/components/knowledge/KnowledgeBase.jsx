import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Spinner } from '../ui';
import { CrawlIcon, FolderIcon, GlobeIcon, ListIcon } from '../icons';
import { WebLinksSection } from './WebLinksSection';
import { LinkListsSection } from './LinkListsSection';
import { CollectionsSection } from './CollectionsSection';
import { CrawlJobsSection } from './CrawlJobsSection';

/**
 * The knowledge base behind the "Upload documents" tab.
 *
 * Everything that can be added to a project's knowledge base lives here: web
 * links that are crawled into documents, link lists that are imported in one
 * go, collections that group documents and links, and the crawl jobs that
 * fetch the pages.
 *
 * The component owns the shared state (links, lists, collections, jobs) because
 * the sections refer to each other: a collection can hold links, a link list
 * imports into a collection.
 */
export function KnowledgeBase({ projectId, documents = [] }) {
  const [links, setLinks] = useState([]);
  const [linkLists, setLinkLists] = useState([]);
  const [collections, setCollections] = useState([]);
  const [crawlJobs, setCrawlJobs] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!projectId) return;
      if (!silent) setLoading(true);
      try {
        const [linkData, listData, collectionData, jobData] = await Promise.all([
          api.listWebLinks(projectId, { limit: 200 }).catch(() => ({ links: [] })),
          api.listLinkLists(projectId).catch(() => ({ linkLists: [] })),
          api.listCollections(projectId).catch(() => ({ collections: [] })),
          api.listCrawlJobs(projectId, { limit: 50 }).catch(() => ({ crawlJobs: [] })),
        ]);
        setLinks(linkData.links || []);
        setLinkLists(listData.linkLists || []);
        setCollections(collectionData.collections || []);
        setCrawlJobs(jobData.crawlJobs || []);
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Keep polling while a crawl is still running so the status stays honest.
  const busy = useMemo(
    () =>
      links.some((l) => l.status === 'pending' || l.status === 'crawling') ||
      crawlJobs.some((j) => j.status === 'queued' || j.status === 'processing'),
    [links, crawlJobs],
  );

  useEffect(() => {
    if (!busy) return undefined;
    const timer = window.setTimeout(() => load({ silent: true }), 3000);
    return () => window.clearTimeout(timer);
  }, [busy, links, crawlJobs, load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Loading the knowledge base…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile icon={<GlobeIcon className="h-4 w-4" />} label="Web links" value={links.length} />
        <SummaryTile icon={<ListIcon className="h-4 w-4" />} label="Link lists" value={linkLists.length} />
        <SummaryTile icon={<FolderIcon className="h-4 w-4" />} label="Collections" value={collections.length} />
        <SummaryTile
          icon={<CrawlIcon className="h-4 w-4" />}
          label="Crawl jobs"
          value={crawlJobs.length}
          hint={crawlJobs.some((j) => j.status === 'failed') ? 'some failed' : null}
        />
      </div>

      <WebLinksSection
        projectId={projectId}
        links={links}
        collections={collections}
        reload={load}
      />
      <LinkListsSection
        projectId={projectId}
        linkLists={linkLists}
        collections={collections}
        reload={load}
      />
      <CollectionsSection
        projectId={projectId}
        collections={collections}
        links={links}
        documents={documents}
        reload={load}
      />
      <CrawlJobsSection crawlJobs={crawlJobs} reload={load} />
    </div>
  );
}

function SummaryTile({ icon, label, value, hint }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
      <span className="text-slate-400">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-slate-500">{label}</p>
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
          {value}
          {hint ? <span className="ml-1 text-[11px] text-amber-600 dark:text-amber-400">{hint}</span> : null}
        </p>
      </div>
    </div>
  );
}
