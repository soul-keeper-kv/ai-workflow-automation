import { PageHeader } from '@/components/app-shell';
import { WorkflowCatalog } from '@/features/workflows/workflow-catalog';

export default function WorkflowsPage() {
  return (
    <>
      <PageHeader title="Workflows" description="Every workflow registered in the backend." />
      <WorkflowCatalog />
    </>
  );
}
