import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const connectionString = process.env.DATABASE_URL;

/**
 * Managed Postgres providers (Replit, Neon, Railway, Supabase, …) terminate TLS
 * with certificates that Node will not verify by default. Locally the DB is
 * usually a plain localhost connection that must NOT use SSL. We enable SSL for
 * every non-local host (with relaxed verification) so the same code works in dev
 * and in production. Override with DATABASE_SSL=false / sslmode=disable if needed.
 */
function shouldUseSsl(url: string): boolean {
  if (process.env.DATABASE_SSL === "false") return false;
  if (/[?&]sslmode=disable/i.test(url)) return false;
  // Local connections (localhost / 127.0.0.1 / ::1 / unix socket) don't use SSL.
  if (/@(localhost|127\.0\.0\.1|\[::1\]|\/)/i.test(url)) return false;
  return true;
}

export const pool = new Pool({
  connectionString,
  ...(shouldUseSsl(connectionString)
    ? { ssl: { rejectUnauthorized: false } }
    : {}),
});

// Prevent the process from crashing if an idle client hits a network error.
pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

export const db = drizzle(pool, { schema });

/**
 * Idempotently create the tables the app needs. Replit (and most PaaS) use a
 * SEPARATE database for deployments than for the dev workspace, so a freshly
 * published app often connects to an EMPTY database — every query (starting with
 * login) then fails with "relation does not exist", surfacing as a 500. Running
 * this once on startup guarantees the schema exists wherever the app is deployed.
 * It is a no-op when the tables are already present, so it is safe to run always.
 */
export async function ensureSchema(): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS authorized_users (
      id SERIAL PRIMARY KEY,
      sicil VARCHAR(50) NOT NULL UNIQUE,
      ad_soyad VARCHAR(255) NOT NULL,
      yetki VARCHAR(20) NOT NULL,
      password_hash VARCHAR(255),
      last_login_at TIMESTAMPTZ,
      ai_query_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT now()
    )`,
    `ALTER TABLE authorized_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`,
    `ALTER TABLE authorized_users ADD COLUMN IF NOT EXISTS ai_query_count INTEGER DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS login_history (
      id SERIAL PRIMARY KEY,
      sicil VARCHAR(50) NOT NULL,
      login_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_login_history_sicil ON login_history(sicil)`,
    `CREATE TABLE IF NOT EXISTS question_sets (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      questions JSONB NOT NULL,
      created_by VARCHAR(50),
      created_by_name VARCHAR(255),
      category VARCHAR(50),
      created_at TIMESTAMP DEFAULT now()
    )`,
    // Var olan (bu iki kolondan önce oluşturulmuş) veritabanlarında tabloyu
    // bozmadan sadece eksik kolonları ekler; IF NOT EXISTS sayesinde tekrar
    // tekrar çalıştırılması güvenli.
    `ALTER TABLE question_sets ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(255)`,
    `ALTER TABLE question_sets ADD COLUMN IF NOT EXISTS category VARCHAR(50)`,
    `CREATE TABLE IF NOT EXISTS system_config (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS game_sessions (
      id SERIAL PRIMARY KEY,
      pin VARCHAR(20),
      title TEXT,
      category VARCHAR(50),
      host_sicil VARCHAR(50),
      question_count INTEGER,
      player_count INTEGER,
      questions JSONB,
      results JSONB,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ
    )`,
    `ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS category VARCHAR(50)`,
  ];

  for (const stmt of statements) {
    await pool.query(stmt);
  }
}

export * from "./schema";
