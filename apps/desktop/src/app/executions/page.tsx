import { Suspense } from 'react';
import { PageHeader } from '@/components/app-shell';
import { LoadingBlock } from '@/components/query-states';
import { ExecutionHistory } from '@/features/executions/execution-history';

export default function ExecutionsPage() {
  return (
    <>
      <PageHeader title="Executions" description="History of every execution, newest first." />
      <Suspense fallback={<LoadingBlock rows={5} />}>
        <ExecutionHistory />
      </Suspense>
    </>
  );
}
