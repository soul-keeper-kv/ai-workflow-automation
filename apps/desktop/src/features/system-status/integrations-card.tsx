'use client';

import type { IntegrationsResponse, WorkflowRequirement } from '@aap/shared';
import { Bot, FolderLock } from 'lucide-react';
import { ErrorAlert, LoadingBlock } from '@/components/query-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useIntegrations } from '@/hooks/use-api';

function WorkspaceRoots({ roots }: { roots: readonly string[] }) {
  if (roots.length === 0) {
    return (
      <p className="text-sm text-destructive">
        No folder is allowed. Set AAP_WORKSPACE_ROOTS and restart the backend.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1 font-mono text-xs">
      {roots.map((root) => (
        <li key={root}>{root}</li>
      ))}
    </ul>
  );
}

/** What the configured AI integration is and where code goes (blueprint §10.3). */
export function IntegrationsCard() {
  const integrations = useIntegrations();
  return (
    <Card data-testid="integrations">
      <CardHeader>
        <CardTitle>Integrations</CardTitle>
        <CardDescription>What workflows may use on this machine.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {integrations.isPending ? (
          <LoadingBlock rows={2} />
        ) : integrations.isError ? (
          <ErrorAlert error={integrations.error} onRetry={() => void integrations.refetch()} />
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 font-medium">
                <Bot className="size-4" aria-hidden />
                {integrations.data.codingAgent.displayName}
                <Badge
                  variant={integrations.data.codingAgent.available ? 'secondary' : 'destructive'}
                >
                  {integrations.data.codingAgent.available ? 'Available' : 'Unavailable'}
                </Badge>
                {integrations.data.codingAgent.version === null ? null : (
                  <span className="font-mono text-xs text-muted-foreground">
                    {integrations.data.codingAgent.version}
                  </span>
                )}
              </div>
              {integrations.data.codingAgent.reason === null ? null : (
                <p className="text-destructive">{integrations.data.codingAgent.reason}</p>
              )}
              <p className="text-muted-foreground">{integrations.data.codingAgent.dataNotice}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 font-medium">
                <FolderLock className="size-4" aria-hidden />
                Allowed workspace folders
              </div>
              <WorkspaceRoots roots={integrations.data.workspaceRoots} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Shown before starting a workflow that uses integrations, so the person knows what it will
 * touch and where code goes before anything runs.
 */
export function RequirementsNotice({
  requirements,
  integrations,
}: {
  requirements: readonly WorkflowRequirement[];
  integrations: IntegrationsResponse | undefined;
}) {
  if (requirements.length === 0 || integrations === undefined) return null;
  return (
    <Alert className="mb-6 max-w-xl" data-testid="requirements-notice">
      <Bot aria-hidden />
      <AlertTitle>Before you start</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        {requirements.includes('coding-agent') ? (
          <span>
            Uses <strong>{integrations.codingAgent.displayName}</strong>.{' '}
            {integrations.codingAgent.dataNotice}
          </span>
        ) : null}
        {requirements.includes('workspace') ? (
          <span className="flex flex-col gap-1">
            Paths must be inside one of these folders:
            <WorkspaceRoots roots={integrations.workspaceRoots} />
          </span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
