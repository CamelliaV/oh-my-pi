import type { Database } from "bun:sqlite";
import { cjkBigramize } from "../../util/regex";

/**
 * CJK-aware FTS mirror sync.
 *
 * bun:sqlite exposes no UDF registration, so the bigram transform for CJK text
 * cannot live inside a SQL trigger. The write side is therefore owned by TS:
 * `initBeam` keeps only the DELETE triggers (`em_ad`/`wm_ad`, plain SQL, no
 * transform needed) and every INSERT/UPDATE site that changes memory text calls
 * {@link resyncFtsRow} to (re)write the bigramized mirror row. Deleting is left
 * to the triggers; superseding/expiring keeps the mirror row harmlessly because
 * every read site filters via `superseded_by`/`valid_until` in SQL.
 */

// EpisodicGraph owns connections that may not run initBeam (its own schema
// only creates gists/facts/edges). Mirror writes are best-effort there: skip
// silently when the FTS mirror tables do not exist on this connection.
function tableExists(db: Database, name: string): boolean {
	return (
		db.query("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?").get(name) !== null
	);
}

function upsertFtsWorking(db: Database, id: string, content: string): void {
	db.run("DELETE FROM fts_working WHERE id = ?", [id]);
	db.run("INSERT INTO fts_working(id, content) VALUES (?, ?)", [id, cjkBigramize(content)]);
}

function upsertFtsEpisodes(db: Database, rowid: number, content: string): void {
	db.run("DELETE FROM fts_episodes WHERE rowid = ?", [rowid]);
	db.run("INSERT INTO fts_episodes(rowid, content) VALUES (?, ?)", [rowid, cjkBigramize(content)]);
}

/** Rewrites the `fts_working` mirror for one working-memory row from its
 * current `COALESCE(embed_text, content)` — the same text the old `wm_ai`
 * trigger indexed. Safe to call repeatedly. */
export function resyncFtsWorking(db: Database, id: string): void {
	const row = db.query("SELECT COALESCE(embed_text, content) AS text FROM working_memory WHERE id = ?").get(id) as {
		text: string | null;
	} | null;
	if (row === null || row.text === null) return;
	upsertFtsWorking(db, id, row.text);
}

/** Rewrites the `fts_episodes` mirror for one episodic-memory row from its
 * current `content`. Safe to call repeatedly. */
export function resyncFtsEpisodes(db: Database, id: string): void {
	const row = db.query("SELECT rowid, content FROM episodic_memory WHERE id = ?").get(id) as {
		rowid: number;
		content: string | null;
	} | null;
	if (row === null || row.content === null) return;
	upsertFtsEpisodes(db, row.rowid, row.content);
}

/** Rewrites the `fts_facts` mirror for one fact row (subject/predicate/object
 * columns), matching what the old `facts_ai` trigger indexed. */
export function resyncFtsFacts(db: Database, rowid: number): void {
	if (!tableExists(db, "fts_facts")) return;
	const row = db.query("SELECT subject, predicate, object FROM facts WHERE rowid = ?").get(rowid) as {
		subject: string | null;
		predicate: string | null;
		object: string | null;
	} | null;
	if (row === null) return;
	db.run("DELETE FROM fts_facts WHERE rowid = ?", [rowid]);
	db.run("INSERT INTO fts_facts(rowid, subject, predicate, object) VALUES (?, ?, ?, ?)", [
		rowid,
		cjkBigramize(row.subject ?? ""),
		cjkBigramize(row.predicate ?? ""),
		cjkBigramize(row.object ?? ""),
	]);
}

/** Rebuilds both content-typed FTS mirrors from scratch. Used by the schema
 * migration for existing banks (whose rows were indexed raw) and as the
 * recovery path when a mirror is found out of sync. Rows are re-derived from
 * the content tables, so mirrors never hold rows the content tables lack. */
export function rebuildFtsMirrors(db: Database): void {
	db.run("DELETE FROM fts_working");
	const wmInsert = db.prepare("INSERT INTO fts_working(id, content) VALUES (?, ?)");
	for (const row of db.query("SELECT id, COALESCE(embed_text, content) AS text FROM working_memory").all() as {
		id: string;
		text: string | null;
	}[]) {
		if (row.text === null) continue;
		wmInsert.run(row.id, cjkBigramize(row.text));
	}
	db.run("DELETE FROM fts_episodes");
	const emInsert = db.prepare("INSERT INTO fts_episodes(rowid, content) VALUES (?, ?)");
	for (const row of db.query("SELECT rowid, content FROM episodic_memory").all() as {
		rowid: number;
		content: string | null;
	}[]) {
		if (row.content === null) continue;
		emInsert.run(row.rowid, cjkBigramize(row.content));
	}
	if (tableExists(db, "facts") && tableExists(db, "fts_facts")) {
		db.run("DELETE FROM fts_facts");
		const factInsert = db.prepare("INSERT INTO fts_facts(rowid, subject, predicate, object) VALUES (?, ?, ?, ?)");
		for (const row of db.query("SELECT rowid, subject, predicate, object FROM facts").all() as {
			rowid: number;
			subject: string | null;
			predicate: string | null;
			object: string | null;
		}[]) {
			factInsert.run(
				row.rowid,
				cjkBigramize(row.subject ?? ""),
				cjkBigramize(row.predicate ?? ""),
				cjkBigramize(row.object ?? ""),
			);
		}
	}
}
