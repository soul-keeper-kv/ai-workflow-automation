'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/app-shell';
import { EmptyState, ErrorAlert, LoadingBlock } from '@/components/query-states';
import { buttonVariants } from '@/components/ui/button';
import { RequirementsNotice } from '@/features/system-status/integrations-card';
import { useIntegrations, useWorkflow } from '@/hooks/use-api';
import { StartWorkflowForm } from './start-workflow-form';

export function StartWorkflowPage() {
  const id = useSearchParams().get('id');
  const workflow = useWorkflow(id);
  const integrations = useIntegrations();

  const back = (
    <Link href="/workflows" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      <ArrowLeft aria-hidden />
      Workflows
    </Link>
  );

  if (id === null) {
    return <EmptyState title="No workflow selected.">Pick one from the catalog.</EmptyState>;
  }
  if (workflow.isPending) return <LoadingBlock />;
  if (workflow.isError) {
    return <ErrorAlert error={workflow.error} onRetry={() => void workflow.refetch()} />;
  }

  const { workflow: summary } = workflow.data;
  return (
    <>
      <PageHeader
        title={`Start: ${summary.name}`}
        description={summary.description}
        actions={back}
      />
      <RequirementsNotice requirements={summary.requirements} integrations={integrations.data} />
      {summary.availability.available ? null : (
        <p className="mb-6 text-sm text-destructive">Unavailable: {summary.availability.reason}</p>
      )}
      <StartWorkflowForm workflow={summary} />
    </>
  );
}
