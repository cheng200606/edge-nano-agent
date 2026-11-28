DROP INDEX `uq_device_commands_dedupe`;--> statement-breakpoint
ALTER TABLE `device_commands` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_device_commands_idempotency` ON `device_commands` (`product_id`,`device_id`,`idempotency_key`);