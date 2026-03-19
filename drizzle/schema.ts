import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, json, decimal } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Providers - sites alvo para criação de contas
 */
export const providers = mysqlTable("providers", {
  id: int("id").autoincrement().primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  baseUrl: varchar("baseUrl", { length: 512 }).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  config: json("config"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Provider = typeof providers.$inferSelect;
export type InsertProvider = typeof providers.$inferInsert;

/**
 * Jobs - tarefas de criação de contas em lote
 */
export const jobs = mysqlTable("jobs", {
  id: int("id").autoincrement().primaryKey(),
  providerId: int("providerId").notNull(),
  status: mysqlEnum("status", ["pending", "running", "paused", "completed", "failed", "cancelled"]).default("pending").notNull(),
  totalAccounts: int("totalAccounts").notNull(),
  completedAccounts: int("completedAccounts").default(0).notNull(),
  failedAccounts: int("failedAccounts").default(0).notNull(),
  concurrency: int("concurrency").default(1).notNull(),
  config: json("config"),
  error: text("error"),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Job = typeof jobs.$inferSelect;
export type InsertJob = typeof jobs.$inferInsert;

/**
 * Accounts - contas criadas com sucesso
 */
export const accounts = mysqlTable("accounts", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId"),
  providerId: int("providerId").notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  password: varchar("password", { length: 256 }).notNull(),
  token: text("token"),
  phone: varchar("phone", { length: 32 }),
  status: mysqlEnum("status", ["active", "banned", "suspended", "unverified", "failed"]).default("active").notNull(),
  metadata: json("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Account = typeof accounts.$inferSelect;
export type InsertAccount = typeof accounts.$inferInsert;

/**
 * Proxies - lista de proxies para rotação
 */
export const proxies = mysqlTable("proxies", {
  id: int("id").autoincrement().primaryKey(),
  host: varchar("host", { length: 256 }).notNull(),
  port: int("port").notNull(),
  username: varchar("username", { length: 128 }),
  password: varchar("password", { length: 256 }),
  protocol: mysqlEnum("protocol", ["http", "https", "socks5"]).default("http").notNull(),
  country: varchar("country", { length: 4 }),
  enabled: boolean("enabled").default(true).notNull(),
  failCount: int("failCount").default(0).notNull(),
  lastUsedAt: timestamp("lastUsedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Proxy = typeof proxies.$inferSelect;
export type InsertProxy = typeof proxies.$inferInsert;

/**
 * Logs - registro de operações e eventos
 */
export const logs = mysqlTable("logs", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId"),
  level: mysqlEnum("level", ["info", "warn", "error", "debug"]).default("info").notNull(),
  source: varchar("source", { length: 64 }),
  message: text("message").notNull(),
  details: json("details"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Log = typeof logs.$inferSelect;
export type InsertLog = typeof logs.$inferInsert;

/**
 * Settings - configurações dinâmicas do sistema
 */
export const settings = mysqlTable("settings", {
  id: int("id").autoincrement().primaryKey(),
  key: varchar("settingKey", { length: 128 }).notNull().unique(),
  value: text("value").notNull(),
  description: text("description"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Setting = typeof settings.$inferSelect;
export type InsertSetting = typeof settings.$inferInsert;

/**
 * Keys - chaves de acesso para resgate de créditos
 */
export const keys = mysqlTable("keys", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  credits: int("credits").notNull(),
  status: mysqlEnum("status", ["active", "redeemed", "expired", "cancelled"]).default("active").notNull(),
  label: varchar("label", { length: 256 }),
  redeemedAt: timestamp("redeemedAt"),
  redeemedBy: varchar("redeemedBy", { length: 256 }),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Key = typeof keys.$inferSelect;
export type InsertKey = typeof keys.$inferInsert;

/**
 * API Tokens - tokens para acesso programático à API
 */
export const apiTokens = mysqlTable("api_tokens", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  tokenHash: varchar("tokenHash", { length: 128 }).notNull().unique(),
  tokenPrefix: varchar("tokenPrefix", { length: 16 }).notNull(),
  permissions: mysqlEnum("permissions", ["full", "read", "jobs_only"]).default("full").notNull(),
  lastUsedAt: timestamp("lastUsedAt"),
  expiresAt: timestamp("expiresAt"),
  revoked: boolean("revoked").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ApiToken = typeof apiTokens.$inferSelect;
export type InsertApiToken = typeof apiTokens.$inferInsert;
