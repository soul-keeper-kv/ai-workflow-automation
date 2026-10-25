import { Suspense } from 'react';
import { LoadingBlock } from '@/components/query-states';
import { ExecutionMonitor } from '@/features/executions/execution-monitor';

// ?id=<execution id>; see the note in app/workflows/start/page.tsx.
export default function ExecutionDetailPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={4} />}>
      <ExecutionMonitor />
    </Suspense>
  );
}
