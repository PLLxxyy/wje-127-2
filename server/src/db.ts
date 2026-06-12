import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(__dirname, '..', 'data', 'repair.db');

// Ensure data directory exists
import fs from 'fs';
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('student', 'admin')),
    building TEXT,
    room TEXT,
    phone TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS repairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    building TEXT NOT NULL,
    room TEXT NOT NULL,
    problem_type TEXT NOT NULL,
    description TEXT NOT NULL,
    photos TEXT DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'resolved', 'cancelled')),
    assigned_to TEXT,
    admin_comment TEXT,
    rating INTEGER,
    review TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (student_id) REFERENCES users(id)
  );
`);

// Migration: update CHECK constraint for repairs.status if needed
(function migrateRepairsStatus() {
  try {
    const pragma = db.pragma('table_info(repairs)') as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
    const statusCol = pragma.find((c) => c.name === 'status');

    // If the CHECK constraint doesn't include 'cancelled', we need to migrate
    // Since SQLite doesn't support ALTER TABLE to modify CHECK constraints directly,
    // we check if 'cancelled' value can be inserted (works if CHECK is not enforced for old tables)
    // or we do a table rebuild if needed.
    // Simpler approach: try inserting and then deleting a test row with status='cancelled'
    try {
      const testId = (db.prepare("INSERT INTO repairs (student_id, building, room, problem_type, description, status) VALUES (0, 'test', '000', 'test', 'test', 'cancelled')").run() as { lastInsertRowid: number }).lastInsertRowid;
      db.prepare('DELETE FROM repairs WHERE id = ?').run(testId);
      // If we reach here, the CHECK constraint already allows 'cancelled' or doesn't enforce it
    } catch {
      // Need to rebuild the table with the new CHECK constraint
      console.log('Migrating repairs table to include cancelled status...');
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE repairs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER NOT NULL,
          building TEXT NOT NULL,
          room TEXT NOT NULL,
          problem_type TEXT NOT NULL,
          description TEXT NOT NULL,
          photos TEXT DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'resolved', 'cancelled')),
          assigned_to TEXT,
          admin_comment TEXT,
          rating INTEGER,
          review TEXT,
          created_at TEXT DEFAULT (datetime('now', 'localtime')),
          updated_at TEXT DEFAULT (datetime('now', 'localtime')),
          FOREIGN KEY (student_id) REFERENCES users(id)
        );
        INSERT INTO repairs_new SELECT * FROM repairs;
        DROP TABLE repairs;
        ALTER TABLE repairs_new RENAME TO repairs;
        PRAGMA foreign_keys = ON;
      `);
      console.log('Migration complete.');
    }
  } catch (migrateErr) {
    console.warn('Migration check/run failed, but continuing:', migrateErr);
  }
})();

export default db;
