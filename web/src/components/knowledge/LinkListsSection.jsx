import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '../ui';
import { ListIcon, TrashIcon } from '../icons';
import { formatRelative } from '../../lib/format';
import { Section, splitUrls, UrlList } from './Section';

/**
 * Link lists: a named set of URLs that can be imported into the knowledge base
 * in one go.
 *
 * A list is only a list - nothing is fetched until it is imported. Importing
 * creates a web link per URL and queues a crawl for each of them.
 */
export function LinkListsSection({ projectId, linkLists, collections, reload }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [urls, setUrls] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const [viewId, setViewId] = useState(null);
  const [viewItems, setViewItems] = useState([]);
  const [extraUrls, setExtraUrls] = useState('');
  const [importTarget, setImportTarget] = useState(null);
  const [importCollection, setImportCollection] = useState('');

  useEffect(() => {
    if (!viewId) {
      setViewItems([]);
      return;
    }
    let cancelled = false;
    api
      .getLinkList(viewId)
      .then((data) => {
        if (!cancelled) setViewItems(data.items || []);
      })
      .catch((err) => toast.error(err.message));
    return () => {
      cancelled = true;
    };
  }, [viewId, toast, reload]);

  const create = async () => {
    if (!name.trim()) {
      toast.error('Give the list a name.');
      return;
    }
    setSaving(true);
    try {
      await api.createLinkList(projectId, {
        name: name.trim(),
        description: description.trim() || null,
        urls: splitUrls(urls),
      });
      toast.success('Link list created');
      setName('');
      setDescription('');
      setUrls('');
      await reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const addItems = async () => {
    const list = splitUrls(extraUrls);
    if (!list.length || !viewId) return;
    setBusyId(viewId);
    try {
      await api.addLinkListItems(viewId, list);
      setExtraUrls('');
      const data = await api.getLinkList(viewId);
      setViewItems(data.items || []);
      toast.success(`${list.length} URL${list.length === 1 ? '' : 's'} added to the list`);
      await reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const importList = async () => {
    const list = importTarget;
    if (!list) return;
    setBusyId(list.id);
    try {
      const res = await api.importLinkList(list.id, importCollection || null);
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
      setImportTarget(null);
      setImportCollection('');
      await reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (list) => {
    setBusyId(list.id);
    try {
      await api.deleteLinkList(list.id);
      toast.success('Link list deleted');
      if (viewId === list.id) setViewId(null);
      await reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Section
      icon={<ListIcon className="h-4 w-4" />}
      title="Link lists"
      description="Group URLs together and import them into the knowledge base in one step."
    >
      <div className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Name" required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Public API reference"
            />
          </Field>
          <Field label="Description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </Field>
        </div>
        <Field label="URLs (one per line)" hint="Optional - you can also add URLs later.">
          <Textarea
            rows={3}
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            placeholder="https://example.com/a"
          />
        </Field>
        <Button onClick={create} loading={saving}>
          Create list
        </Button>
      </div>

      <div className="mt-3">
        {linkLists.length === 0 ? (
          <EmptyState
            icon={<ListIcon className="h-6 w-6 text-slate-400" />}
            title="No link lists yet"
            description="Create a list to keep a set of URLs together before importing them."
          />
        ) : (
          <ul className="space-y-2">
            {linkLists.map((list) => (
              <li
                key={list.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2 dark:border-slate-800"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {list.name}
                  </p>
                  <p className="truncate text-[11px] text-slate-400">
                    {list.description ? `${list.description} · ` : ''}
                    {list.item_count} URL{list.item_count === 1 ? '' : 's'} · updated{' '}
                    {formatRelative(list.updated_at)}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Badge tone="slate">{list.item_count}</Badge>
                  <Button size="sm" variant="outline" onClick={() => setViewId(list.id)}>
                    View
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setImportTarget(list)}>
                    Import
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(list)}
                    disabled={busyId === list.id}
                    title="Delete this list"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Modal
        open={Boolean(viewId)}
        onClose={() => setViewId(null)}
        title="Link list"
        wide
        footer={
          <Button variant="secondary" onClick={() => setViewId(null)}>
            Close
          </Button>
        }
      >
        <div className="space-y-3">
          <UrlList urls={viewItems.map((i) => i.url)} />
          <Field label="Add URLs (one per line)">
            <Textarea
              rows={3}
              value={extraUrls}
              onChange={(e) => setExtraUrls(e.target.value)}
              placeholder="https://example.com/b"
            />
          </Field>
          <Button size="sm" onClick={addItems} loading={busyId === viewId}>
            Add to list
          </Button>
        </div>
      </Modal>

      <Modal
        open={Boolean(importTarget)}
        onClose={() => setImportTarget(null)}
        title="Import link list"
        footer={
          <>
            <Button variant="secondary" onClick={() => setImportTarget(null)} disabled={Boolean(busyId)}>
              Cancel
            </Button>
            <Button onClick={importList} loading={Boolean(busyId)}>
              Import &amp; crawl
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Every URL of “{importTarget?.name}” becomes a web link and is crawled into the knowledge base.
        </p>
        <div className="mt-3">
          <Field label="Collection" hint="Optional - the new links are added to this collection.">
            <Select value={importCollection} onChange={(e) => setImportCollection(e.target.value)}>
              <option value="">No collection</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>
    </Section>
  );
}
