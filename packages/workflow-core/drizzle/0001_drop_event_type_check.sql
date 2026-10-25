PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`execution_id` text NOT NULL,
	`event_type` text NOT NULL,
	`state_before` text,
	`state_after` text,
	`payload_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_workflow_events`("id", "execution_id", "event_type", "state_before", "state_after", "payload_json", "created_at") SELECT "id", "execution_id", "event_type", "state_before", "state_after", "payload_json", "created_at" FROM `workflow_events`;--> statement-breakpoint
DROP TABLE `workflow_events`;--> statement-breakpoint
ALTER TABLE `__new_workflow_events` RENAME TO `workflow_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `workflow_events_execution_idx` ON `workflow_events` (`execution_id`,`id`);