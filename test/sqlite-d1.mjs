import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function database({ legacyOnly = false } = {}) {
  const sql = new DatabaseSync(':memory:');
  const migrations = readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort();
  for (const migration of (legacyOnly ? migrations.slice(0, 1) : migrations)) sql.exec(readFileSync(new URL('../drizzle/' + migration, import.meta.url), 'utf8'));
  const executed = [];
  const db = {
    sql, executed, reads: [], beforeRead: null, failBeforeCommit: false, failAfterCommit: false, batchCount: 0,
    prepare(query) {
      const statement = { query, values: [],
        bind(...values) { return { ...statement, values }; },
        async run() { return execute(this); },
        async all() {
          if (db.beforeRead) await db.beforeRead(this);
          const results = sql.prepare(this.query).all(...this.values);
          db.reads.push({ query: this.query, values: this.values, rows: results.length,
            bytes: Buffer.byteLength(JSON.stringify(results)) });
          return { success: true, results };
        },
      };
      return statement;
    },
    async batch(statements) {
      db.batchCount++;
      sql.exec('BEGIN IMMEDIATE');
      let result;
      try {
        result = statements.map(execute);
        if (db.failBeforeCommit) throw new Error('Injected failure');
        sql.exec('COMMIT');
      } catch (error) { sql.exec('ROLLBACK'); throw error; }
      if (db.failAfterCommit) throw new Error('Injected lost response');
      return result;
    },
  };
  function execute(stmt) {
    executed.push({ query: stmt.query, values: stmt.values });
    const result = sql.prepare(stmt.query).run(...stmt.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
  return db;
}
