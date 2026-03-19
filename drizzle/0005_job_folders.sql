-- Migration: Add job_folders table and folderId to jobs
-- Allows grouping multiple jobs under a single client folder

CREATE TABLE `job_folders` (
  `id` int AUTO_INCREMENT NOT NULL,
  `clientName` varchar(256) NOT NULL,
  `inviteCode` varchar(128) NOT NULL,
  `totalJobs` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `job_folders_id` PRIMARY KEY (`id`)
);

ALTER TABLE `jobs` ADD COLUMN `folderId` int;
