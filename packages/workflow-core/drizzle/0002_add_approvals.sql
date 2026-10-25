CREATE TABLE `workflow_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`state` text NOT NULL,
	`approval_type` text NOT NULL,
	`status` text NOT NULL,
	`request_payload_json` text NOT NULL,
	`decision_payload_json` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workflow_approvals_status_check" CHECK("workflow_approvals"."status" in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE INDEX `workflow_approvals_execution_idx` ON `workflow_approvals` (`execution_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workflow_approvals_status_idx` ON `workflow_approvals` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_approvals_one_pending_idx` ON `workflow_approvals` (`execution_id`) WHERE "workflow_approvals"."status" = 'PENDING';