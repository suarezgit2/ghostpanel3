CREATE TABLE `accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int,
	`providerId` int NOT NULL,
	`email` varchar(320) NOT NULL,
	`password` varchar(256) NOT NULL,
	`phone` varchar(32),
	`status` enum('active','banned','suspended','unverified') NOT NULL DEFAULT 'active',
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`providerId` int NOT NULL,
	`status` enum('pending','running','paused','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
	`totalAccounts` int NOT NULL,
	`completedAccounts` int NOT NULL DEFAULT 0,
	`failedAccounts` int NOT NULL DEFAULT 0,
	`concurrency` int NOT NULL DEFAULT 1,
	`config` json,
	`error` text,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int,
	`level` enum('info','warn','error','debug') NOT NULL DEFAULT 'info',
	`source` varchar(64),
	`message` text NOT NULL,
	`details` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`slug` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`baseUrl` varchar(512) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`config` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `providers_id` PRIMARY KEY(`id`),
	CONSTRAINT `providers_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `proxies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`host` varchar(256) NOT NULL,
	`port` int NOT NULL,
	`username` varchar(128),
	`password` varchar(256),
	`protocol` enum('http','https','socks5') NOT NULL DEFAULT 'http',
	`country` varchar(4),
	`enabled` boolean NOT NULL DEFAULT true,
	`failCount` int NOT NULL DEFAULT 0,
	`lastUsedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `proxies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`settingKey` varchar(128) NOT NULL,
	`value` text NOT NULL,
	`description` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `settings_settingKey_unique` UNIQUE(`settingKey`)
);
