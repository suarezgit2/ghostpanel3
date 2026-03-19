CREATE TABLE `api_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(128) NOT NULL,
	`tokenHash` varchar(128) NOT NULL,
	`tokenPrefix` varchar(16) NOT NULL,
	`permissions` enum('full','read','jobs_only') NOT NULL DEFAULT 'full',
	`lastUsedAt` timestamp,
	`expiresAt` timestamp,
	`revoked` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `api_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_tokens_tokenHash_unique` UNIQUE(`tokenHash`)
);
