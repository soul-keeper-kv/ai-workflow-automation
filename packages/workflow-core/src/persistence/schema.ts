import {
  APPROVAL_STATUSES,
  EXECUTION_EVENT_TYPES,
  EXECUTION_STATUSES,
  STEP_RUN_STATUSES,
} from '@aap/shared';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Timestamps are integer milliseconds since the Unix epoch: UTC by definition.
// JSON columns are plain text, parsed and validated by the code that reads them.

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const workflowExecutions = sqliteTable(
  'workflow_executions',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id').notNull(),
    workflowVersion: text('workflow_version').notNull(),
    status: text('status', { enum: EXECUTION_STATUSES }).notNull(),
    /** The workflow machine's state. Separate from the lifecycle `status`. */
    currentState: text('current_state').notNull(),
    inputJson: text('input_json').notNull(),
    /** Machine context: with current_state, everything needed to resume. */
    contextJson: text('context_json').notNull(),
    outputJson: text('output_json'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** Incremented by every update; writers must name the revision they read. */
    revision: integer('revision').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('workflow_executions_status_idx').on(t.status),
    index('workflow_executions_workflow_created_idx').on(t.workflowId, t.createdAt),
    index('workflow_executions_created_idx').on(t.createdAt),
    check('workflow_executions_status_check', sql`${t.status} in (${inList(EXECUTION_STATUSES)})`),
  ],
);

export const workflowStepExecutions = sqliteTable(
  'workflow_step_executions',
  {
    id: text('id').primaryKey(),
    executionId: text('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    /** The machine state the step belongs to. */
    stepId: text('step_id').notNull(),
    status: text('status', { enum: STEP_RUN_STATUSES }).notNull(),
    attempt: integer('attempt').notNull(),
    /** The event the step returned. */
    outputJson: text('output_json'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('workflow_step_executions_execution_idx').on(t.executionId, t.startedAt),
    index('workflow_step_executions_step_idx').on(t.executionId, t.stepId),
    // At most one step runs per execution at a time.
    uniqueIndex('workflow_step_executions_one_running_idx')
      .on(t.executionId)
      .where(sql`${t.status} = 'RUNNING'`),
    check(
      'workflow_step_executions_status_check',
      sql`${t.status} in (${inList(STEP_RUN_STATUSES)})`,
    ),
  ],
);

export const workflowEvents = sqliteTable(
  'workflow_events',
  {
    /** Autoincrement: the order events happened in, even within one millisecond. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    executionId: text('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    eventType: text('event_type', { enum: EXECUTION_EVENT_TYPES }).notNull(),
    stateBefore: text('state_before'),
    stateAfter: text('state_after'),
    payloadJson: text('payload_json'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('workflow_events_execution_idx').on(t.executionId, t.id),
    // No CHECK on event_type: the list grows, and SQLite can only change a CHECK by rebuilding
    // the table. The store validates event types when it reads them.
  ],
);

export const workflowApprovals = sqliteTable(
  'workflow_approvals',
  {
    id: text('id').primaryKey(),
    executionId: text('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    /** The approval state of the machine that asked for it. */
    state: text('state').notNull(),
    approvalType: text('approval_type').notNull(),
    status: text('status', { enum: APPROVAL_STATUSES }).notNull(),
    requestPayloadJson: text('request_payload_json').notNull(),
    decisionPayloadJson: text('decision_payload_json'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('workflow_approvals_execution_idx').on(t.executionId, t.createdAt),
    index('workflow_approvals_status_idx').on(t.status),
    // An execution waits on at most one request at a time.
    uniqueIndex('workflow_approvals_one_pending_idx')
      .on(t.executionId)
      .where(sql`${t.status} = 'PENDING'`),
    check('workflow_approvals_status_check', sql`${t.status} in (${inList(APPROVAL_STATUSES)})`),
  ],
);

export const schema = {
  workflowExecutions,
  workflowStepExecutions,
  workflowEvents,
  workflowApprovals,
};
