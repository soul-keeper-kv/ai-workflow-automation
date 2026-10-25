'use client';

import type { Approval, ExecutionDetail } from '@aap/shared';
import { Check, UserCheck, X } from 'lucide-react';
import { useState } from 'react';
import { JsonBlock } from '@/components/json-block';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useDecideApproval } from '@/hooks/use-api';
import { formatDateTime } from '@/lib/format';

const MAX_FEEDBACK = 4000;

/**
 * Renders the request generically: text fields as readable text, everything else as JSON.
 * The request is untrusted JSON from a workflow; it is displayed, never interpreted as HTML.
 */
export function ApprovalRequest({ request }: { request: unknown }) {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return <JsonBlock value={request} />;
  }
  return (
    <dl className="flex flex-col gap-3">
      {Object.entries(request as Record<string, unknown>).map(([key, value]) => (
        <div key={key} className="flex flex-col gap-1">
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {key}
          </dt>
          <dd>
            {typeof value === 'string' ? (
              <p
                className={
                  value.length > 400
                    ? 'max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap'
                    : 'text-sm whitespace-pre-wrap'
                }
              >
                {value}
              </p>
            ) : (
              <JsonBlock value={value} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ApprovalPanel({
  execution,
  approval,
}: {
  execution: ExecutionDetail;
  approval: Approval;
}) {
  const decide = useDecideApproval();
  const [feedback, setFeedback] = useState('');

  const submit = (decision: 'APPROVED' | 'REJECTED') =>
    decide.mutate({ executionId: execution.id, approvalId: approval.id, decision, feedback });

  return (
    <Card className="border-amber-500/50" data-testid="approval-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCheck className="size-5 text-amber-600" aria-hidden />
          {approval.stateTitle}
        </CardTitle>
        <CardDescription>
          The execution is waiting for your decision ({approval.approvalType}, requested{' '}
          {formatDateTime(approval.createdAt)}).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ApprovalRequest request={approval.request} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="approval-feedback">Feedback (optional)</Label>
          <Textarea
            id="approval-feedback"
            rows={3}
            maxLength={MAX_FEEDBACK}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </div>
        {decide.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{decide.error.message}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex gap-2">
          <Button disabled={decide.isPending} onClick={() => submit('APPROVED')}>
            <Check aria-hidden />
            Approve
          </Button>
          <Button
            variant="destructive"
            disabled={decide.isPending}
            onClick={() => submit('REJECTED')}
          >
            <X aria-hidden />
            Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ApprovalHistory({ approvals }: { approvals: readonly Approval[] }) {
  const decided = approvals.filter((approval) => approval.status !== 'PENDING');
  if (decided.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Approvals</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3 text-sm">
          {decided.map((approval) => (
            <li key={approval.id} className="flex flex-col gap-0.5">
              <span>
                <span className="font-medium">{approval.stateTitle}</span>
                {' · '}
                {approval.status === 'CANCELLED'
                  ? 'closed without a decision'
                  : approval.status.toLowerCase()}
                {' · '}
                <span className="text-muted-foreground">{formatDateTime(approval.decidedAt)}</span>
              </span>
              {approval.decision?.feedback ? (
                <span className="text-muted-foreground">“{approval.decision.feedback}”</span>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
