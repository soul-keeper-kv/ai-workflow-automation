import { Suspense } from 'react';
import { LoadingBlock } from '@/components/query-states';
import { StartWorkflowPage } from '@/features/workflows/start-workflow-page';

// The workflow id is a query parameter (?id=...), not a path segment: the app is a static
// export and ids are only known at runtime. See docs/adr/0002.
export default function StartPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <StartWorkflowPage />
    </Suspense>
  );
}
