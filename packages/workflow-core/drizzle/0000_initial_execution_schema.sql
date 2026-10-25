CREATE TABLE `workflow_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`execution_id` text NOT NULL,
	`event_type` text NOT NULL,
	`state_before` text,
	`state_after` text,
	`payload_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workflow_events_type_check" CHECK("workflow_events"."event_type" in ('EXECUTION_CREATED', 'STATUS_CHANGED', 'STEP_STARTED', 'STEP_SUCCEEDED', 'STEP_FAILED', 'STEP_INTERRUPTED', 'STATE_CHANGED'))
);
--> statement-breakpoint
CREATE INDEX `workflow_events_execution_idx` ON `workflow_events` (`execution_id`,`id`);--> statement-breakpoint
CREATE TABLE `workflow_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_version` text NOT NULL,
	`status` text NOT NULL,
	`current_state` text NOT NULL,
	`input_json` text NOT NULL,
	`context_json` text NOT NULL,
	`output_json` text,
	`error_code` text,
	`error_message` text,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT "workflow_executions_status_check" CHECK("workflow_executions"."status" in ('PENDING', 'RUNNING', 'WAITING_FOR_APPROVAL', 'INTERRUPTED', 'FAILED', 'CANCELLED', 'COMPLETED'))
);
--> statement-breakpoint
CREATE INDEX `workflow_executions_status_idx` ON `workflow_executions` (`status`);--> statement-breakpoint
CREATE INDEX `workflow_executions_workflow_created_idx` ON `workflow_executions` (`workflow_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workflow_executions_created_idx` ON `workflow_executions` (`created_at`);--> statement-breakpoint
CREATE TABLE `workflow_step_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`step_id` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer NOT NULL,
	`output_json` text,
	`error_code` text,
	`error_message` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workflow_step_executions_status_check" CHECK("workflow_step_executions"."status" in ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED'))
);
--> statement-breakpoint
CREATE INDEX `workflow_step_executions_execution_idx` ON `workflow_step_executions` (`execution_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `workflow_step_executions_step_idx` ON `workflow_step_executions` (`execution_id`,`step_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_step_executions_one_running_idx` ON `workflow_step_executions` (`execution_id`) WHERE "workflow_step_executions"."status" = 'RUNNING';