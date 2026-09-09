export interface WikiSourceRef {
	id: string;
	revision: number;
}

export interface WikiSource extends WikiSourceRef {
	content: string;
	context?: string;
	source?: string;
	cursor?: string;
	createdAt: string;
	updatedAt: string;
	status: "active" | "invalidated";
}

export type WikiPageKind = "knowledge" | "preference" | "pattern";

export interface WikiPage {
	id: string;
	revision: number;
	title: string;
	summary: string;
	body: string;
	kind: WikiPageKind;
	status: "active" | "conflicted" | "invalidated";
	sources: WikiSourceRef[];
	links: string[];
	updatedAt: string;
}

export interface WikiPageDraft {
	id: string;
	expectedRevision: number | null;
	title: string;
	summary: string;
	body: string;
	kind: WikiPageKind;
	status: "active" | "conflicted";
	sources: WikiSourceRef[];
	links: string[];
}

export interface WikiSnapshot {
	version: string;
	pages: WikiPage[];
	pending: WikiSource[];
}

export interface WikiMaintenance {
	pages: WikiPageDraft[];
	processed: WikiSourceRef[];
}

export interface WikiCaptureInput {
	content: string;
	context?: string;
	source?: string;
	cursor?: string;
}

export interface WikiMutation {
	op: "update" | "forget" | "invalidate";
	content?: string;
	importance?: number;
	replacementId?: string;
}

export interface WikiMutationResult {
	status: "updated" | "deleted" | "invalidated" | "not_found" | "not_editable";
	affectedPages: string[];
}

export interface WikiCompletionRequest {
	task: "maintain" | "recall" | "skill";
	system: string;
	prompt: string;
	maxTokens: number;
	signal?: AbortSignal;
}

export type WikiComplete = (request: WikiCompletionRequest) => Promise<string>;

export interface WikiRecallItem {
	id: string;
	revision: number;
	title: string;
	content: string;
	sources: WikiSourceRef[];
	conflicted: boolean;
	updatedAt: string;
}

export interface WikiRecallResult {
	status: "found" | "not_found";
	items: WikiRecallItem[];
}

export interface WikiSkillDraft {
	name: string;
	description: string;
	body: string;
	reason: string;
	pages: WikiSourceRef[];
}

export interface WikiSkillCandidate extends WikiSkillDraft {
	id: string;
	createdAt: string;
	status: "pending" | "accepted" | "rejected" | "invalidated";
	validation?: {
		kind: "behavioral" | "manual";
		baseline?: number;
		candidate?: number;
		report: string;
	};
	publishedHash?: string;
}

/** Recorded once per content revision; processing acknowledgements are not revisions. */
export interface WikiRevisionChange {
	operation: "baseline" | "capture" | "publish" | "update" | "invalidate" | "restore";
	reason: string;
	restoredFrom?: number;
}

export interface WikiRevisionInfo extends WikiSourceRef {
	type: "page" | "source";
	status: "active" | "conflicted" | "invalidated";
	updatedAt: string;
	current: boolean;
	change: WikiRevisionChange;
}

export interface WikiRevision extends WikiRevisionInfo {
	record: WikiPage | WikiSource;
}

export interface WikiRestoreResult {
	id: string;
	revision: number;
	restoredFrom: number;
	affectedPages: string[];
}

export type WikiHistoryEntry = WikiRevisionInfo;
