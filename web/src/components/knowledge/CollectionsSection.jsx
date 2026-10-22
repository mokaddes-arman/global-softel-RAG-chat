import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  useToast,
} from '../ui';
import { FolderIcon, TrashIcon } from '../icons';
import { formatRelative } from '../../lib/format';
import { Section } from './Section';

/**
 * Collections: named groups of documents and web links.
 *
 * A collection is a view over the knowledge base, not a copy: the documents
 * and links it holds keep their own versions and crawl history.
 */
export function CollectionsSection({ projectId, collections, links, documents, reload }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const [openId, setOpenId] = useState(null);
  const [items, setItems] = useState([]);
  const [pickedDocs, setPickedDocs] = useState([]);
  const [pickedLinks, setPickedLinks] = useState([]);

  const openCollection = collections.find((c) => c.id === openId) || null;

  const loadItems = useCallback(async (id) => {
    const data = await api.getCollection(id);
    setItems(data.items || []);
  }, []);

  useEffect(() => {
    if (!openId) {
      setItems([]);
      return;
    }
    loadItems(openId).catch((err) => toast.error(err.message));
  }, [openId, loadItems, toast]);

  const toggle = (list, id) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const create = async () => {
    if (!name.trim()) {
      toast.error('Give the collection a name.');
      return;
    }
    setSaving(true);
    try {
      await api.createCollection(projectId, {
        name: name.trim(),
        description: description.trim() || null,
      });
      toast.success('Collection created');
      setName('');
      setDescription('');
      await reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const addSelected = async () => {
    if (!openId) return;
    setBusyId(openId);
    try {
      const res = await api.addCollectionItems(openId, {
        documentIds: pickedDocs,
        webLinkIds: pickedLinks,
      });
      const added = res.added || { documents: 0, links: 0 };
      if (added.documents || added.links) {
        toast.success(
          `Added ${added.documents} document${added.documents === 1 ? '' : 's'} and ${added.links} link${
            added.links === 1 ? '' : 's'
          }`,
        );
      } else {
        toast.info('Those items are already in the collection.');
      }
      setPickedDocs([]);
      setPickedLinks([]);
      await loadItems(openId);
      await reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const removeItem = async (item) => {
    if (!openId) return;
    setBusyId(openId);
    try {
      await api.removeCollectionItem(openId, item.id);
      await loadItems(openId);
      await reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (collection) => {
    setBusyId(collection.id);
    try {
      await api.deleteCollection(collection.id);
      toast.success('Collection deleted');
      if (openId === collection.id) setOpenId(null);
      await reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const linkedIds = useMemo(() => new Set(items.map((i) => i.document_id).filter(Boolean)), [items]);
  const linkedLinkIds = useMemo(() => new Set(items.map((i) => i.web_link_id).filter(Boolean)), [items]);

  return (
    <Section
      icon={<FolderIcon className="h-4 w-4" />}
      title="Collections"
      description="Group documents and web links together so a topic can be handled as one."
    >
      <div className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Release notes" />
          </Field>
          <Field label="Description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </Field>
        </div>
        <Button onClick={create} loading={saving}>
          Create collection
        </Button>
      </div>

      <div className="mt-3">
        {collections.length === 0 ? (
          <EmptyState
            icon={<FolderIcon className="h-6 w-6 text-slate-400" />}
            title="No collections yet"
            description="Create a collection to keep the documents and links of one topic together."
          />
        ) : (
          <ul className="space-y-2">
            {collections.map((collection) => (
              <li
                key={collection.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2 dark:border-slate-800"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {collection.name}
                  </p>
                  <p className="truncate text-[11px] text-slate-400">
                    {collection.description ? `${collection.description} · ` : ''}
                    {collection.document_count} document{collection.document_count === 1 ? '' : 's'} ·{' '}
                    {collection.link_count} link{collection.link_count === 1 ? '' : 's'} · updated{' '}
                    {formatRelative(collection.updated_at)}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Badge tone="slate">{collection.item_count}</Badge>
                  <Button size="sm" variant="outline" onClick={() => setOpenId(collection.id)}>
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(collection)}
                    disabled={busyId === collection.id}
                    title="Delete this collection"
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
        open={Boolean(openCollection)}
        onClose={() => setOpenId(null)}
        title={openCollection ? `Collection · ${openCollection.name}` : 'Collection'}
        wide
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpenId(null)}>
              Close
            </Button>
            <Button onClick={addSelected} loading={busyId === openId}>
              Add selected
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              In this collection
            </p>
            {items.length === 0 ? (
              <p className="text-xs text-slate-400">Nothing yet.</p>
            ) : (
              <ul className="space-y-1">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-2 py-1.5 text-xs dark:border-slate-800"
                  >
                    <span className="min-w-0 truncate text-slate-700 dark:text-slate-200">
                      {item.document_id
                        ? `${item.document_title || 'Document'} · ${item.original_filename || ''}`
                        : `${item.link_title || 'Web link'} · ${item.link_url || ''}`}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeItem(item)}
                      title="Remove from this collection"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Add documents
              </p>
              {documents.length === 0 ? (
                <p className="text-xs text-slate-400">This project has no documents yet.</p>
              ) : (
                <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 text-xs dark:border-slate-800">
                  {documents.map((doc) => (
                    <li key={doc.id}>
                      <label className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
                        <input
                          type="checkbox"
                          disabled={linkedIds.has(doc.id)}
                          checked={pickedDocs.includes(doc.id)}
                          onChange={() => setPickedDocs((prev) => toggle(prev, doc.id))}
                        />
                        <span className="truncate" title={doc.title}>
                          {doc.title}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Add web links
              </p>
              {links.length === 0 ? (
                <p className="text-xs text-slate-400">This project has no web links yet.</p>
              ) : (
                <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 text-xs dark:border-slate-800">
                  {links.map((link) => (
                    <li key={link.id}>
                      <label className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
                        <input
                          type="checkbox"
                          disabled={linkedLinkIds.has(link.id)}
                          checked={pickedLinks.includes(link.id)}
                          onChange={() => setPickedLinks((prev) => toggle(prev, link.id))}
                        />
                        <span className="truncate" title={link.title || link.url}>
                          {link.title || link.url}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </Modal>
    </Section>
  );
}
