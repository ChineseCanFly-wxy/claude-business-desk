import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BUSINESS_PROMPT } from './claude/prompt.js';

export const activeStates = ['pending_question_review', 'queued', 'running', 'pending_answer_review'];
export const defaultSettings = { claudePath: '', mode: 'hidden' as 'hidden' | 'visible', timeoutSeconds: 300, clientHost: '127.0.0.1', clientPort: 4311, adminPort: 4310, allowInsecureLan: false, adminNotificationMode: 'window' as 'window' | 'notification', fixedPrompt: DEFAULT_BUSINESS_PROMPT, extraPrompt: '' };
export type Settings = typeof defaultSettings;
export class Store {
  db: DatabaseSync;
  constructor(public directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'desk.sqlite'));
    const version = (this.db.prepare('PRAGMA user_version').get() as any).user_version;
    if (version > 4) { this.db.close(); throw new Error(`数据库版本 ${version} 高于当前支持版本 4，拒绝打开`); }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    try { this.transaction(() => {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','client')),enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),portal TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',path TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS grants(user_id TEXT NOT NULL REFERENCES users(id),project_id TEXT NOT NULL REFERENCES projects(id),PRIMARY KEY(user_id,project_id));
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),project_id TEXT NOT NULL REFERENCES projects(id),question TEXT NOT NULL,status TEXT NOT NULL,draft_answer TEXT,answer TEXT,error TEXT,archived INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_question ON questions(user_id) WHERE status IN ('pending_question_review','queued','running','pending_answer_review');
      CREATE INDEX IF NOT EXISTS question_history ON questions(user_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS question_queue ON questions(status,created_at);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,exit_code INTEGER,logs TEXT NOT NULL DEFAULT '',session_id TEXT,cost_usd REAL,error TEXT);
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
      `);
    if (version < 2) {
      this.db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),project_id TEXT NOT NULL REFERENCES projects(id),created_at TEXT NOT NULL);
        ALTER TABLE questions ADD COLUMN conversation_id TEXT REFERENCES conversations(id);
        ALTER TABLE questions ADD COLUMN turn_index INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE questions ADD COLUMN parent_question_id TEXT REFERENCES questions(id);
        ALTER TABLE questions ADD COLUMN context_snapshot TEXT NOT NULL DEFAULT '{"formatVersion":1,"sourceIds":[],"turns":[]}';
        ALTER TABLE runs ADD COLUMN input_snapshot TEXT;
        CREATE UNIQUE INDEX conversation_turn ON questions(conversation_id,turn_index);`);
      for (const q of this.db.prepare('SELECT id,user_id,project_id,created_at FROM questions').all() as any[]) {
        const id = randomUUID();
        this.db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run(id, q.user_id, q.project_id, q.created_at);
        this.db.prepare('UPDATE questions SET conversation_id=? WHERE id=?').run(id, q.id);
      }
      this.db.exec('PRAGMA user_version=2;');
    }
    if (version < 3) {
      this.db.exec(`CREATE TABLE question_deletions(user_id TEXT NOT NULL REFERENCES users(id),question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(user_id,question_id));
        CREATE INDEX deleted_questions ON question_deletions(question_id);
        ALTER TABLE conversations ADD COLUMN claude_session_id TEXT;
        ALTER TABLE conversations ADD COLUMN claude_session_path TEXT;
        PRAGMA user_version=3;`);
    }
    if (version < 4) {
      this.db.exec(`CREATE TABLE attachments(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),project_id TEXT NOT NULL REFERENCES projects(id),question_id TEXT REFERENCES questions(id),name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,data BLOB NOT NULL,prepared TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX attachment_questions ON attachments(question_id);
        CREATE INDEX attachment_owners ON attachments(user_id,question_id);
        ALTER TABLE runs ADD COLUMN attachment_reads TEXT NOT NULL DEFAULT '[]';
        PRAGMA user_version=4;`);
    }
    this.db.prepare('INSERT OR IGNORE INTO settings(id,value) VALUES(1,?)').run(JSON.stringify(defaultSettings));
    }); } catch (error) { this.db.close(); throw error; }
  }
  settings(): Settings { return { ...defaultSettings, ...JSON.parse((this.db.prepare('SELECT value FROM settings WHERE id=1').get() as any).value) }; }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(actor: string, action: string, target: string) {
    this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(randomUUID(), actor, action, target, new Date().toISOString());
  }
  close() { this.db.close(); }
}
