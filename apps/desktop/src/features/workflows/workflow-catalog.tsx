'use client';

import type { WorkflowSummary } from '@aap/shared';
import { Play } from 'lucide-react';
import Link from 'next/link';
import { EmptyState, ErrorAlert, LoadingBlock } from '@/components/query-states';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useWorkflows } from '@/hooks/use-api';
import { buildFormModel } from './schema-fields';

function requiredInputs(workflow: WorkflowSummary): string[] {
  const model = buildFormModel(workflow.inputSchema);
  return model === null ? [] : model.fields.filter((f) => f.required).map((f) => f.label);
}

function WorkflowCard({ workflow }: { workflow: WorkflowSummary }) {
  const inputs = requiredInputs(workflow);
  return (
    <Card data-testid={`workflow-${workflow.id}`}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{workflow.name}</CardTitle>
          <Badge variant="secondary">{workflow.category}</Badge>
        </div>
        <CardDescription>{workflow.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <div>
          <span className="text-muted-foreground">Required inputs: </span>
          {inputs.length === 0 ? 'none' : inputs.join(', ')}
        </div>
        <div>
          <span className="text-muted-foreground">Steps: </span>
          {workflow.states.filter((s) => s.kind === 'step').length}
          <span className="text-muted-foreground"> · Version </span>
          <span className="font-mono">{workflow.version}</span>
        </div>
        {workflow.availability.available ? null : (
          <p className="text-destructive">Unavailable: {workflow.availability.reason}</p>
        )}
      </CardContent>
      <CardFooter>
        {workflow.availability.available ? (
          <Link
            href={`/workflows/start?id=${encodeURIComponent(workflow.id)}`}
            className={buttonVariants({ size: 'sm' })}
          >
            <Play aria-hidden />
            Start
          </Link>
        ) : null}
      </CardFooter>
    </Card>
  );
}

export function WorkflowCatalog() {
  const workflows = useWorkflows();

  if (workflows.isPending) return <LoadingBlock rows={2} />;
  if (workflows.isError) {
    return <ErrorAlert error={workflows.error} onRetry={() => void workflows.refetch()} />;
  }
  if (workflows.data.workflows.length === 0) {
    return <EmptyState title="No workflows are registered." />;
  }
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {workflows.data.workflows.map((workflow) => (
        <WorkflowCard key={workflow.id} workflow={workflow} />
      ))}
    </div>
  );
}
