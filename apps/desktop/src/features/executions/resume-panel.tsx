'use client';

import type { ExecutionDetail } from '@aap/shared';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useResumeExecution } from '@/hooks/use-api';

/**
 * Offered only for INTERRUPTED executions. Resuming re-runs the current step from the start,
 * so the person confirms after reading what that means.
 */
export function ResumePanel({ execution }: { execution: ExecutionDetail }) {
  const resume = useResumeExecution();
  const [confirming, setConfirming] = useState(false);

  return (
    <Alert data-testid="resume-panel">
      <TriangleAlert aria-hidden />
      <AlertTitle>This execution needs a decision</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>
          Resuming runs “{execution.currentStateTitle}” again from the start. If the interrupted
          attempt already changed files or other systems, those changes may happen twice. Check them
          first, or cancel the execution instead.
        </span>
        {resume.isError ? <span className="text-destructive">{resume.error.message}</span> : null}
        {confirming ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={resume.isPending}
              onClick={() => resume.mutate(execution.id)}
            >
              <RotateCcw aria-hidden />
              Re-run step
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Not now
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
            <RotateCcw aria-hidden />
            Resume…
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
