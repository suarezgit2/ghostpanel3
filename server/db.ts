import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

/**
 * Aplica DDL pendente diretamente via SQL inline.
 * Usa CREATE TABLE IF NOT EXISTS e ADD COLUMN IF NOT EXISTS para ser idempotente.
 * Não depende de arquivos externos — funciona em qualquer ambiente (Railway, Docker, etc).
 */
export async function runMigrations(): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn("[Migrations] Database não disponível, pulando migrations");
    return;
  }

  console.log("[Migrations] Aplicando DDL pendente...");

  try {
    // Migration 0005: job_folders table + folderId column on jobs
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`job_folders\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`clientName\` varchar(256) NOT NULL,
        \`inviteCode\` varchar(128) NOT NULL,
        \`totalJobs\` int NOT NULL DEFAULT 0,
        \`createdAt\` timestamp NOT NULL DEFAULT (now()),
        \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`job_folders_id\` PRIMARY KEY (\`id\`)
      )
    `);

    // ADD COLUMN IF NOT EXISTS is supported in MySQL 8.0+ and TiDB
    await db.execute(sql`
      ALTER TABLE \`jobs\`
        ADD COLUMN IF NOT EXISTS \`folderId\` int NULL
    `);

    console.log("[Migrations] DDL aplicado com sucesso");
  } catch (error) {
    console.error("[Migrations] Erro ao aplicar DDL:", error);
    // Não lança o erro para não impedir o boot
  }
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// TODO: add feature queries here as your schema grows.
