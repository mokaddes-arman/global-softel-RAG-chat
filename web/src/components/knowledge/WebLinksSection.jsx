import React, { useState } from 'react';
import { api } from '../../api';
import { Badge, Button, EmptyState, Field, Input, Select, Textarea, statusTone, useToast } from '../ui';
import { GlobeIcon, RefreshIcon, TrashIcon } from '../icons';
import { formatNumber, formatRelative } from '../../lib/format';
import { Section, splitUrls } from './Section';

/**
 * Web links: pages on the internet that are fetched and turned into documents.
 *
 * Adding a link queues a crawl. A crawl stores the page as a Markdown
 * document and indexes it, so the page answers questions exactly like an
 * uploaded file. "Re-crawl" fetches the page again and adds a new version.
 */
export function WebLinksSection({ projectId, links, collections, reload }) {
  const toast = useToast();
  const [urls, setUrls] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const add = async () => {
    const list = splitUrls(urls);
    if (!list.length) {
      toast.error('Enter at least one URL.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.createWebLinks(projectId, { urls: list, collectionId: collectionId || null });
      const created = res.created || [];
      const errors = res.errors || [];
      const skipped = res.skipped || [];
      if (created.length) {
        toast.success(`${created.length} link${created.length === 1 ? '' : 's'} queued for crawling`);
      }
      for (const e of errors) toast.error(`${e.url}: ${e.message}`);
      if (skipped.length) {
        toast.info(`${skipped.length} link${skipped.length === 1 ? ' is' : 's are'} already in the knowledge base`);
      }
      setUrls('');
      setCollectionId('');
      await reload({ silent: true });
    } catch (err) {
      const details = err.body?.errors || [];
      if (details.length) details.forEach((e) => toast.error(`${e.url}: ${e.message}`));
      else toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const recrawl = async (link) => {
    setBusyId(link.id);
    try {
      await api.crawlWebLink(link.id);
      toast.success(`Re-crawl queued for “${link.title || link.url}”`);
      await reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (link) => {
    setBusyId(link.id);
    try {
      await api.deleteWebLink(link.id);
      toast.success('Link removed');
      await reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const assignCollection = async (link, nextCollectionId) => {
    setBusyId(link.id);
    try {
      await api.updateWebLink(link.id, { collectionId: nextCollectionId || null });
      await reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Section
      icon={<GlobeIcon className="h-4 w-4" />}
      title="Web links"
      description="Pages that are fetched from the internet and indexed like a document."
    >
      <div className="space-y-2">
        <Field label="URLs (one per line)" hint="Only public http(s) pages are fetched.">
          <Textarea
            rows={3}
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            placeholder="https://example.com/docs"
          />
        </Field>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Collection" className="min-w-[180px]">
            <Select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
              <option value="">No collection</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button onClick={add} loading={saving}>
            Add &amp; crawl
          </Button>
        </div>
      </div>

      <div className="mt-3">
        {links.length === 0 ? (
          <EmptyState
            icon={<GlobeIcon className="h-6 w-6 text-slate-400" />}
            title="No web links yet"
            description="Add a URL above and it is crawled into the knowledge base automatically."
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
            <table className="w-full min-w-[640px] text-xs">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-900">
                <tr>
                  <th className="px-2 py-1.5">Page</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5">Collection</th>
                  <th className="px-2 py-1.5">Crawls</th>
                  <th className="px-2 py-1.5">Chunks</th>
                  <th className="px-2 py-1.5">Updated</th>
                  <th className="px-2 py-1.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr
                    key={link.id}
                    className="border-t border-slate-100 dark:border-slate-800"
                  >
                    <td className="max-w-[280px] px-2 py-1.5">
                      <p className="truncate font-medium text-slate-800 dark:text-slate-100" title={link.title || link.url}>
                        {link.title || link.url}
                      </p>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="block truncate text-[11px] text-blue-600 hover:underline dark:text-blue-400"
                        title={link.url}
                      >
                        {link.url}
                      </a>
                      {link.last_error ? (
                        <p className="truncate text-[11px] text-red-600 dark:text-red-400" title={link.last_error}>
                          {link.last_error}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge tone={statusTone(link.status)}>{link.status}</Badge>
                    </td>
                    <td className="px-2 py-1.5">
                      <Select
                        className="min-w-[120px] py-0.5 text-[11px]"
                        value={link.collection_id || ''}
                        disabled={busyId === link.id}
                        onChange={(e) => assignCollection(link, e.target.value)}
                      >
                        <option value="">None</option>
                        {collections.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-2 py-1.5 text-slate-600 dark:text-slate-300">
                      {formatNumber(link.crawl_count)}
                    </td>
                    <td className="px-2 py-1.5 text-slate-600 dark:text-slate-300">
                      {formatNumber(link.chunk_count)}
                    </td>
                    <td className="px-2 py-1.5 text-slate-500">{formatRelative(link.updated_at)}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => recrawl(link)}
                          loading={busyId === link.id}
                          title="Re-crawl this page"
                        >
                          <RefreshIcon className="h-3.5 w-3.5" /> Re-crawl
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => remove(link)}
                          disabled={busyId === link.id}
                          title="Remove this link"
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Section>
  );
}
