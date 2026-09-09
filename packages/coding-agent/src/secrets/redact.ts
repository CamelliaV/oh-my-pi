import type { SecretObfuscator } from "./obfuscator";
import { PLACEHOLDER_RE } from "./placeholder";
import { deepWalkStrings } from "./placeholder-scan";

const REDACTED = "[REDACTED]";
const SECRET_FIELD =
	/^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|token|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|private[-_]?key)$/i;
const CREDENTIAL_PATTERNS = [
	/\b(?:sk|pk|rk|tok|key|secret|token|password)[_-][A-Za-z0-9_-]{12,}/gi,
	/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
	/(?:AKIA|ASIA)[A-Z0-9]{16}/g,
	/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
	/github_pat_[A-Za-z0-9_]{20,}/g,
	/npm_[A-Za-z0-9]{30,}/g,
	/xox[baprs]-[A-Za-z0-9-]{10,}/g,
	/AIza[A-Za-z0-9_-]{30,}/g,
	/-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
];
const CREDENTIAL_ASSIGNMENT =
	/(\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|token|authorization|proxy-authorization)\b["']?\s*[:=]\s*)(\[REDACTED\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:(?:Bearer|Basic)\s+)?[^\s,;&}\]]+)/gi;

/** Irreversibly redact memory text, including secrets already represented by reversible placeholders. */
export function redactSecrets(input: string, obfuscator?: SecretObfuscator): string {
	let out = obfuscator?.obfuscate(input) ?? input;
	// Memory is durable knowledge, not an executable tool argument: do not retain
	// placeholders that a future session could turn back into credentials.
	out = out.replace(PLACEHOLDER_RE, REDACTED);
	for (const pattern of CREDENTIAL_PATTERNS) out = out.replace(pattern, REDACTED);
	out = out
		.replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
		.replace(CREDENTIAL_ASSIGNMENT, (_match, prefix: string, value: string) => {
			const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
			return `${prefix}${quote}${REDACTED}${quote}`;
		})
		.replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]{8,}=*/gi, `$1${REDACTED}`);
	return out;
}

/** Redact typed memory payloads without mutating caller data or flattening Dates. */
export function redactSecretFields<T>(value: T, obfuscator?: SecretObfuscator): T {
	return deepWalkStrings(value, (text, key) =>
		key !== undefined && SECRET_FIELD.test(key) ? REDACTED : redactSecrets(text, obfuscator),
	);
}
