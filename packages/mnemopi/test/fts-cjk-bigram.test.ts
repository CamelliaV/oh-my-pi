/**
 * CJK recall through the FTS signal. Contract: a memory whose Chinese text is
 * written without word separators (the normal case) must be findable by a
 * two-character sub-run query through the FTS index — not only through the
 * LIKE fallback. Before the bigram protocol, unicode61 indexed a whole CJK run
 * as one token (`记忆库召回` → `记忆库召回`), and the query side emitted the
 * same whole-run phrase, so no sub-run query could ever match: Chinese FTS
 * recall contributed zero rows.
 *
 * The fix splices CJK runs into overlapping bigrams on BOTH sides: the FTS
 * mirrors store `cjkBigramize(text)` (`fts-sync.ts`), and `tokenize` in
 * `beam/recall.ts` decomposes query runs the same way.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { RecallResult } from "@oh-my-pi/pi-mnemopi/core/beam";
import { recall } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { remember, updateWorking } from "@oh-my-pi/pi-mnemopi/core/beam/store";
import { cjkBigramize } from "@oh-my-pi/pi-mnemopi/util/regex";

process.env.MNEMOPI_NO_EMBEDDINGS = "1";

type BeamState = Parameters<typeof remember>[0];

function makeBeam(db: Database): BeamState {
	return {
		db,
		sessionId: "bank-cjk",
		authorId: null,
		authorType: null,
		channelId: "bank-cjk",
		useCloud: false,
		pluginManager: null,
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
		},
	};
}

describe("cjkBigramize", () => {
	test("splices CJK runs into overlapping bigrams, single chars and ASCII untouched", () => {
		expect(cjkBigramize("mnemopi 记忆库召回评估管线")).toBe("mnemopi 记忆 忆库 库召 召回 回评 评估 估管 管线");
		expect(cjkBigramize("单")).toBe("单");
		expect(cjkBigramize("english only 123")).toBe("english only 123");
	});
});

describe("CJK FTS recall through the bigram protocol", () => {
	let db: Database;
	let beam: BeamState;

	beforeAll(() => {
		db = new Database(":memory:");
		initBeam(db);
		beam = makeBeam(db);
	});

	afterAll(() => {
		db.close();
	});

	test("two-char CJK query matches a memory stored without word separators, via fts", async () => {
		const id = remember(beam, "部署了 mnemopi 记忆库召回评估管线，用于评估中文召回质量", { importance: 0.9 });
		// The FTS mirror must hold bigramized text, not the raw run.
		const mirror = db.query("SELECT content FROM fts_working WHERE id = ?").get(id) as
			| { content: string }
			| undefined;
		expect(mirror?.content).toContain("召回 回评");

		// And the mirror must actually answer a 2-char query through MATCH.
		const ftsHits = db.query("SELECT id FROM fts_working WHERE fts_working MATCH ?").all('"召回"') as {
			id: string;
		}[];
		expect(ftsHits.map(row => row.id)).toContain(id);

		const results = await recall(beam, "召回评估", 10);
		expect(results.map(result => result.id)).toContain(id);
	});

	test("ASCII recall is unaffected by the bigram protocol", async () => {
		const id = remember(beam, "kitty graphics protocol notes", {
			importance: 0.9,
		});
		const results = await recall(beam, "kitty graphics", 10);
		expect(results.map(result => result.id)).toContain(id);
	});

	test("updateWorking re-syncs the mirror with bigramized new content", async () => {
		const id = remember(beam, "占位内容", { importance: 0.9 });
		expect(updateWorking(beam, id, "渲染异常排查记录")).toBe(true);
		const mirror = db.query("SELECT content FROM fts_working WHERE id = ?").get(id) as
			| { content: string }
			| undefined;
		expect(mirror?.content).toBe("渲染 染异 异常 常排 排查 查记 记录");
		const results = await recall(beam, "异常", 10);
		expect(results.map((result: RecallResult) => result.id)).toContain(id);
	});

	test("legacy bank with raw-indexed triggers is migrated on initBeam", () => {
		const old = new Database(":memory:");
		old.run(`CREATE TABLE working_memory (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			embed_text TEXT DEFAULT NULL,
			session_id TEXT DEFAULT 'default',
			scope TEXT DEFAULT 'global',
			timestamp TEXT,
			source TEXT
		)`);
		old.run(`CREATE VIRTUAL TABLE fts_working USING fts5(id UNINDEXED, content)`);
		old.run(`CREATE TRIGGER wm_ai AFTER INSERT ON working_memory BEGIN
			INSERT INTO fts_working(id, content) VALUES (new.id, COALESCE(new.embed_text, new.content));
		END`);
		old.run("INSERT INTO working_memory (id, content) VALUES ('legacy1', '记忆库召回评估管线')");
		// Raw mirror: whole-run token, 2-char query impossible.
		expect(
			(old.query("SELECT id FROM fts_working WHERE fts_working MATCH ?").all('"召回"') as unknown[]).length,
		).toBe(0);

		initBeam(old);
		expect(old.query("SELECT COUNT(*) AS c FROM fts_working").get()).toEqual({
			c: 1,
		});
		expect(
			(old.query("SELECT id FROM fts_working WHERE fts_working MATCH ?").all('"召回"') as { id: string }[]).map(
				row => row.id,
			),
		).toEqual(["legacy1"]);
		old.close();
	});

	test("reopening an in-sync bank preserves the mirrors instead of rebuilding", () => {
		const bank = new Database(":memory:");
		initBeam(bank);
		const bankBeam = makeBeam(bank);
		const id = remember(bankBeam, "状态栏启动延迟归因记录", { importance: 0.9 });
		// Marker that a rebuild would erase: rewrite the mirror row's content
		// (counts stay in sync) and reopen. The unconditional rebuild this
		// replaces wiped + re-derived every mirror row on every open.
		bank.run("UPDATE fts_working SET content = 'marker-kept' WHERE id = ?", [id]);
		initBeam(bank);
		const mirror = bank.query("SELECT content FROM fts_working WHERE id = ?").get(id) as
			| { content: string }
			| undefined;
		expect(mirror?.content).toBe("marker-kept");
		bank.close();
	});

	test("reopening after count drift rebuilds the drifted mirror", () => {
		const bank = new Database(":memory:");
		initBeam(bank);
		const bankBeam = makeBeam(bank);
		const id = remember(bankBeam, "恢复中断的镜像重建记录", { importance: 0.9 });
		// Simulate a crash between the content INSERT and its resync: the mirror
		// row never landed, so counts drift and the next open must rebuild.
		bank.run("DELETE FROM fts_working WHERE id = ?", [id]);
		initBeam(bank);
		const mirror = bank.query("SELECT content FROM fts_working WHERE id = ?").get(id) as
			| { content: string }
			| undefined;
		expect(mirror?.content).toBe("恢复 复中 中断 断的 的镜 镜像 像重 重建 建记 记录");
		bank.close();
	});
});
