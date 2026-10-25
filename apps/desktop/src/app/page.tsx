import { BackendStatusCard } from '@/features/system-status/backend-status-card';

export default function DashboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">AI Automation Platform</h1>
        <p className="text-sm text-muted-foreground">
          Desktop shell. Workflows, executions and approvals are not built yet.
        </p>
      </header>
      <BackendStatusCard />
    </main>
  );
}
