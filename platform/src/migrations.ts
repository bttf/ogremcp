import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

import { failureCode } from "./db.js";

/**
 * The migration runner (D1, §13.1). It applies the numbered SQL files of
 * `platform/migrations/` and records each one in `schema_migrations`.
 * `migrate.ts` is the command.
 *
 * Files are named `NNNN_short_description.sql`. A file is never edited once
 * it has been applied anywhere: a change is a new file with the next number.
 * There are no down-migrations. A file holds plain SQL, with no psql
 * meta-commands and no transaction statements other than an optional leading
 * `begin;` and trailing `commit;` (`stripTransaction`).
 *
 * A file is pending when `schema_migrations` has no row with its number.
 * Pending files run in numeric order, each in its own transaction together
 * with the insert of its row. A file that fails is rolled back whole and stays
 * pending; the files before it stay applied. A file added with a lower number
 * than one already applied is still pending and runs on the next migrate, so
 * two branches can each add a file and merge in either order.
 *
 * `0001` creates `schema_migrations`, so on an empty database it runs first
 * and records itself.
 *
 * One migrate runs at a time. A run holds a Postgres advisory lock from the
 * moment it reads what is applied until its last file commits, so two deploys,
 * or two self-host containers that start together (§13.3), never apply a file
 * twice.
 */

/** `platform/migrations`, one level up from this file under `src/` and under `dist/` alike. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** The advisory lock key a migrate holds. Nothing else takes this lock. */
const MIGRATE_LOCK = 1_300_286;

export interface MigrationFile {
  /** The `NNNN` of the name, as a number. */
  version: number;
  name: string;
  path: string;
}

/** A failure of the database or of the connection to it. The message holds a code only (`failureCode`). */
export class DatabaseFailure extends Error {
  constructor(readonly code: string) {
    super(`database failure code=${code}`);
    this.name = "DatabaseFailure";
  }
}

/** A migration file that failed and was rolled back. The message names the file and the SQLSTATE, never the Postgres message. */
export class MigrationFailure extends Error {
  constructor(
    readonly file: MigrationFile,
    readonly code: string,
  ) {
    super(`${file.name} failed and was rolled back: code=${code}`);
    this.name = "MigrationFailure";
  }
}

/** The files of `dir` in numeric order. Throws on a `.sql` name outside `NNNN_name.sql` and on a number used twice. */
export async function listMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".sql")) continue;
    const match = FILE_NAME.exec(name);
    if (match === null) throw new Error(`migration file ${name} is not named NNNN_short_description.sql`);
    files.push({ version: Number(match[1]), name, path: join(dir, name) });
  }
  files.sort((a, b) => a.version - b.version);
  for (const [i, file] of files.entries()) {
    const previous = files[i - 1];
    if (previous !== undefined && previous.version === file.version) {
      throw new Error(`migration files ${previous.name} and ${file.name} have the same number`);
    }
  }
  return files;
}

/** The recorded versions, or null when `schema_migrations` does not exist yet. */
async function appliedVersions(client: Pool | PoolClient): Promise<Set<number> | null> {
  const { rows } = await client.query<{ table: string | null }>("select to_regclass('schema_migrations') as table");
  if (rows[0]?.table == null) return null;
  const applied = await client.query<{ version: number }>("select version from schema_migrations");
  return new Set(applied.rows.map((row) => row.version));
}

export interface MigrationStatus {
  /** False on a database where `0001` has not run. */
  tracked: boolean;
  pending: MigrationFile[];
}

/** What a migrate would apply, without applying it or taking the lock. */
export async function migrationStatus(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationStatus> {
  const files = await listMigrationFiles(dir);
  let applied: Set<number> | null;
  try {
    applied = await appliedVersions(pool);
  } catch (err) {
    throw new DatabaseFailure(failureCode(err));
  }
  return { tracked: applied !== null, pending: files.filter((file) => !applied?.has(file.version)) };
}

interface Statement {
  /** The statement without its comments, trimmed. */
  text: string;
  /** Offset of its first character that is not whitespace or a comment. */
  start: number;
  /** Offset just past its semicolon, or the end of the file. */
  end: number;
}

const IDENTIFIER_CHAR = /^[A-Za-z0-9_$]$/;
const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

/** Offset just past the quote that closes the one at `open`. A doubled quote, or with `backslash` a backslash, escapes the next character. */
function closeQuote(sql: string, open: number, backslash: boolean): number {
  const quote = sql.charAt(open);
  let i = open + 1;
  while (i < sql.length) {
    const c = sql.charAt(i);
    if (backslash && c === "\\") {
      i += 2;
    } else if (c === quote && sql.charAt(i + 1) === quote) {
      i += 2;
    } else if (c === quote) {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return sql.length;
}

/**
 * The statements of a file, split at the semicolons outside comments, quoted
 * strings and identifiers, and dollar-quoted bodies. One pass over the text.
 */
function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let text = "";
  let start = -1;
  const push = (end: number) => {
    const trimmed = text.trim();
    if (trimmed !== "") statements.push({ text: trimmed, start, end });
    text = "";
    start = -1;
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql.charAt(i);
    const pair = sql.slice(i, i + 2);
    if (pair === "--") {
      const eol = sql.indexOf("\n", i);
      i = eol === -1 ? sql.length : eol;
      text += " ";
      continue;
    }
    if (pair === "/*") {
      // Block comments nest in Postgres.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        const inner = sql.slice(i, i + 2);
        if (inner === "/*" || inner === "*/") {
          depth += inner === "/*" ? 1 : -1;
          i += 2;
        } else {
          i += 1;
        }
      }
      text += " ";
      continue;
    }
    if (c === ";") {
      push(i + 1);
      i += 1;
      continue;
    }
    if (start === -1 && c.trim() !== "") start = i;
    let stop = i + 1;
    const before = sql.charAt(i - 1);
    if (c === "'" || c === '"') {
      // E'...' strings take backslash escapes.
      const escaped = c === "'" && (before === "E" || before === "e") && !IDENTIFIER_CHAR.test(sql.charAt(i - 2));
      stop = closeQuote(sql, i, escaped);
    } else if (c === "$" && !IDENTIFIER_CHAR.test(before)) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(sql)?.[0];
      if (tag !== undefined) {
        const close = sql.indexOf(tag, i + tag.length);
        stop = close === -1 ? sql.length : close + tag.length;
      }
    }
    text += sql.slice(i, stop);
    i = stop;
  }
  push(sql.length);
  return statements;
}

/** First words of the statements that open, end, or change a transaction. */
const TRANSACTION_CONTROL = new Set(["abort", "begin", "commit", "end", "release", "rollback", "savepoint", "start"]);

/**
 * A file may open with `begin;` and close with `commit;`, the form that runs
 * as-is under psql. The runner supplies the transaction itself, so both are
 * taken out; one without the other is refused. Any other transaction
 * statement is refused too: a `commit;` inside the file would commit part of
 * it without its `schema_migrations` row. A `begin atomic` function body reads
 * as one, so write the body in `$$` quotes. Comments stay.
 */
export function stripTransaction(name: string, sql: string): string {
  const statements = splitStatements(sql);
  const first = statements[0];
  const last = statements[statements.length - 1];
  const opens = first?.text.toLowerCase() === "begin";
  const closes = statements.length > 1 && last?.text.toLowerCase() === "commit";
  if (opens !== closes) throw new Error(`migration file ${name} has a begin without a commit, or the other way round`);
  for (const statement of opens ? statements.slice(1, -1) : statements) {
    const word = /^[a-z]+/i.exec(statement.text)?.[0].toLowerCase();
    if (word !== undefined && TRANSACTION_CONTROL.has(word)) {
      throw new Error(`migration file ${name} has a ${word} statement: a file may only open with begin; and close with commit;`);
    }
  }
  if (!opens || first === undefined || last === undefined) return sql;
  return sql.slice(0, first.start) + sql.slice(first.end, last.start) + sql.slice(last.end);
}

export interface MigrateOptions {
  dir?: string;
  /** Receives one line per file applied. */
  log?: (line: string) => void;
}

/**
 * Applies every pending file, in numeric order, and returns them. Throws a
 * `MigrationFailure` naming the file that failed: the files before it stay
 * applied and recorded, and the failed one is rolled back. Throws a
 * `DatabaseFailure` when the database cannot be reached or asked.
 */
export async function migrate(pool: Pool, options: MigrateOptions = {}): Promise<MigrationFile[]> {
  const log = options.log ?? (() => {});
  const files = await listMigrationFiles(options.dir);

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    throw new DatabaseFailure(failureCode(err));
  }
  let locked = false;
  try {
    let applied: Set<number> | null;
    try {
      await client.query("select pg_advisory_lock($1)", [MIGRATE_LOCK]);
      locked = true;
      applied = await appliedVersions(client);
    } catch (err) {
      throw new DatabaseFailure(failureCode(err));
    }
    const pending = files.filter((file) => !applied?.has(file.version));

    // Every pending file is read before the first one runs, so a bad file
    // stops the run before the database changes.
    const contents = new Map<MigrationFile, string>();
    for (const file of pending) contents.set(file, stripTransaction(file.name, await readFile(file.path, "utf8")));

    const done: MigrationFile[] = [];
    for (const file of pending) {
      try {
        await client.query("begin");
        // No parameters, so pg sends the text as one simple query and the
        // file may hold any number of statements.
        await client.query(contents.get(file) ?? "");
        await client.query("insert into schema_migrations (version, name) values ($1, $2)", [file.version, file.name]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw new MigrationFailure(file, failureCode(err));
      }
      done.push(file);
      log(`applied ${file.name}`);
    }
    return done;
  } finally {
    // The lock belongs to the connection, and the connection goes back to the
    // pool. Unlock it, or drop the connection when the unlock fails.
    let reusable = true;
    if (locked) {
      await client.query("select pg_advisory_unlock($1)", [MIGRATE_LOCK]).catch(() => {
        reusable = false;
      });
    }
    client.release(!reusable);
  }
}
