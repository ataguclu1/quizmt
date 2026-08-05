import { pgTable, serial, varchar, jsonb, timestamp, text, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const authorizedUsersTable = pgTable("authorized_users", {
  id: serial("id").primaryKey(),
  sicil: varchar("sicil", { length: 50 }).notNull().unique(),
  adSoyad: varchar("ad_soyad", { length: 255 }).notNull(),
  yetki: varchar("yetki", { length: 20 }).notNull(),
  passwordHash: varchar("password_hash", { length: 255 }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  aiQueryCount: integer("ai_query_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

// Her başarılı girişin kaydı — "giriş bilgileri" panelinde yakından geçmişe
// doğru tarih listesi göstermek için. Sadece tarih/saat tutuyoruz, başka
// hiçbir hassas veri yok, DB'yi şişirmez (kullanıcı başına birkaç KB/yıl).
export const loginHistoryTable = pgTable("login_history", {
  id: serial("id").primaryKey(),
  sicil: varchar("sicil", { length: 50 }).notNull(),
  loginAt: timestamp("login_at", { withTimezone: true }).defaultNow(),
});

export const questionSetsTable = pgTable("question_sets", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  questions: jsonb("questions").notNull(),
  createdBy: varchar("created_by", { length: 50 }),
  createdByName: varchar("created_by_name", { length: 255 }),
  category: varchar("category", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const systemConfigTable = pgTable("system_config", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
});

// Finished game results. Written via raw SQL in the socket layer; defined here so
// `drizzle-kit push` provisions it and the schema stays the single source of truth.
export const gameSessionsTable = pgTable("game_sessions", {
  id: serial("id").primaryKey(),
  pin: varchar("pin", { length: 20 }),
  title: text("title"),
  category: varchar("category", { length: 50 }),
  hostSicil: varchar("host_sicil", { length: 50 }),
  questionCount: integer("question_count"),
  playerCount: integer("player_count"),
  questions: jsonb("questions"),
  results: jsonb("results"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const insertAuthorizedUserSchema = createInsertSchema(authorizedUsersTable).omit({ id: true, createdAt: true });
export const insertQuestionSetSchema = createInsertSchema(questionSetsTable).omit({ id: true, createdAt: true });

export type AuthorizedUser = typeof authorizedUsersTable.$inferSelect;
export type InsertAuthorizedUser = z.infer<typeof insertAuthorizedUserSchema>;
export type QuestionSet = typeof questionSetsTable.$inferSelect;
export type InsertQuestionSet = z.infer<typeof insertQuestionSetSchema>;
export type GameSession = typeof gameSessionsTable.$inferSelect;
