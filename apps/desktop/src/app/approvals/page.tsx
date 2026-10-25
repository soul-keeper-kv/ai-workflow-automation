import { PageHeader } from '@/components/app-shell';
import { PendingApprovals } from '@/features/executions/pending-approvals';

export default function ApprovalsPage() {
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Executions that are paused until someone approves or rejects them."
      />
      <PendingApprovals />
    </>
  );
}
