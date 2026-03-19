import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import { InsertUser, users } from "../drizzle/schema";
import { ENV } from './_core/env';
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 * Roda todas as migrations pendentes usando drizzle-orm/mysql2/migrator.
 * Deve ser chamado uma vez no startup do servidor, antes de qualquer query.
 * É idempotente: migrations já aplicadas são ignoradas.
 */
export async function runMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn("[Migrations] DATABASE_URL não definida, pulando migrations");
    return;
  }

  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection(process.env.DATABASE_URL);
    const db = drizzle(connection);

    const migrationsFolder = path.resolve(__dirname, "../../drizzle");

    console.log("[Migrations] Aplicando migrations pendentes...");
    await migrate(db, { migrationsFolder });
    console.log("[Migrations] Migrations aplicadas com sucesso");
  } catch (error) {
    console.error("[Migrations] Erro ao aplicar migrations:", error);
    // Não lança o erro para não impedir o boot do servidor
    // O servidor pode funcionar mesmo se uma migration falhar (ex: já aplicada manualmente)
  } finally {
    if (connection) {
      await connection.end().catch(() => {});
    }
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
