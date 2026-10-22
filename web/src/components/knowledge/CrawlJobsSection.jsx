import React, { useState } from 'react';
import { api } from '../../api';
import { Badge, Button, EmptyState, statusTone, useToast } from '../ui';
import { CrawlIcon, RefreshIcon } from '../icons';
import { formatRelative } from '../../lib/format';
import { Section } from './Section';

/**
 * Crawl jobs: the queue that fetches the linked pages.
 *
 * A job moves through `queued` -> `processing` -> `completed` (or `failed`).
 * A failed job can be retried, which puts the link back into the queue.
 */
export function CrawlJobsSection({ crawlJobs, reload }) {
  const toast = useToast();
  const [busyId, setBusyId] = useState(null);

  const retry = async (job) => {
    setBusyId(job.id);
    try {
      await api.retryCrawlJob(job.id);
      toast.success('Crawl re-queued');
      await reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Section
      icon={<CrawlIcon className="h-4 w-4" />}
      title="Crawl jobs"
      description="Every fetch of a web link is recorded here."
    >
      {crawlJobs.length === 0 ? (
        <EmptyState
          icon={<CrawlIcon className="h-6 w-6 text-slate-400" />}
          title="No crawl jobs yet"
          description="Add a web link and its crawl shows up here."
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-900">
              <tr>
                <th className="px-2 py-1.5">Page</th>
                <th className="px-2 py-1.5">Type</th>
                <th className="px-2 py-1.5">Status</th>
                <th className="px-2 py-1.5">Attempts</th>
                <th className="px-2 py-1.5">Queued</th>
                <th className="px-2 py-1.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {crawlJobs.map((job) => (
                <tr key={job.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="max-w-[280px] px-2 py-1.5">
                    <p className="truncate font-medium text-slate-800 dark:text-slate-100" title={job.link_title || job.url}>
                      {job.link_title || job.url}
                    </p>
                    <p className="truncate text-[11px] text-slate-400" title={job.url}>
                      {job.url}
                    </p>
                    {job.error ? (
                      <p className="truncate text-[11px] text-red-600 dark:text-red-400" title={job.error}>
                        {job.error}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 text-slate-600 dark:text-slate-300">{job.job_type}</td>
                  <td className="px-2 py-1.5">
                    <Badge tone={statusTone(job.status)}>{job.status}</Badge>
                  </td>
                  <td className="px-2 py-1.5 text-slate-600 dark:text-slate-300">
                    {job.attempts}/{job.max_attempts}
                  </td>
                  <td className="px-2 py-1.5 text-slate-500">{formatRelative(job.created_at)}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => retry(job)}
                        loading={busyId === job.id}
                        disabled={job.status === 'processing'}
                        title="Queue this crawl again"
                      >
                        <RefreshIcon className="h-3.5 w-3.5" /> Retry
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
