import type { ExtensionAPI, ExtensionContext, MessageRenderer, SessionEntry } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import { Box, Spacer, Text } from "@mariozechner/pi-tui";
import { createHash } from "node:crypto";
import { renderMermaidAscii } from "beautiful-mermaid";

const MESSAGE_TYPE = "pi-mermaid";
const MERMAID_BLOCK_RE = /```mermaid\s*([\s\S]*?)```/gi;
const ISSUE_LINE_RE = /^\[mermaid:(warning|error)\](?:\[hash:[^\]]+\])?\s*(.*)$/;
const COLLAPSED_LINES = 10;
const MAX_BLOCKS = 5;
const MAX_SOURCE_LINES = 400;
const MAX_SOURCE_CHARS = 20000;
const MAX_SEEN_ISSUES = 200;
const MAX_ASCII_CACHE = 200;
const SUPPORTED_TYPES = new Map<string, string>([
	["graph", "flowchart"],
	["flowchart", "flowchart"],
	["sequenceDiagram", "sequence"],
	["classDiagram", "class"],
	["erDiagram", "er"],
	["stateDiagram", "state"],
	["stateDiagram-v2", "state"],
]);
const SUPPORTED_TYPE_LABEL = "graph/flowchart, sequenceDiagram, classDiagram, erDiagram, stateDiagram(-v2)";

let mermaidParser: ((text: string) => Promise<void>) | null = null;
let mermaidParserError: string | null = null;
let mermaidParserWarned = false;
const seenIssueKeys = new Map<string, true>();
const asciiCache = new Map<string, { ascii: string; lineCount: number }>();

function isDomPurifyError(message: string): boolean {
	return message.includes("DOMPurify.addHook") || message.includes("DOMPurify");
}

async function getMermaidParser(): Promise<((text: string) => Promise<void>) | null> {
	if (mermaidParser || mermaidParserError) return mermaidParser;

	try {
		const mod = await import("mermaid");
		const api = (mod as any).default ?? (mod as any).mermaidAPI ?? mod;
		if (!api || typeof api.parse !== "function") {
			mermaidParserError = "Mermaid parse API not available";
			return null;
		}
		if (typeof api.initialize === "function") {
			try {
				api.initialize({ startOnLoad: false });
			} catch {
				// ignore initialization errors
			}
		}
		mermaidParser = async (text: string) => {
			const result = api.parse(text);
			if (result && typeof result.then === "function") {
				await result;
			}
		};
		return mermaidParser;
	} catch (error) {
		mermaidParserError = error instanceof Error ? error.message : String(error);
		return null;
	}
}

interface MermaidIssue {
	severity: "warning" | "error";
	message: string;
}

interface MermaidDetails {
	source: string;
	index: number;
	ascii: string;
	lineCount: number;
	issues?: MermaidIssue[];
}

type MermaidNotification = { message: string; type: "warning" | "error" };

type ProcessBlockResult = {
	diagramHash: string;
	details: MermaidDetails;
	issues: MermaidIssue[];
	notifications: MermaidNotification[];
};

function normalizeMermaidSource(source: string): string {
	return source.replace(/\s+$/g, "");
}

function formatIssueLines(issues: MermaidIssue[], hash: string): string {
	if (issues.length === 0) return "";
	return issues.map((issue) => `[mermaid:${issue.severity}][hash:${hash}] ${issue.message}`).join("\n");
}

function buildContextContent(
	block: string,
	hash: string,
	issues: MermaidIssue[],
	includeSource: boolean,
): string {
	const issueLines = formatIssueLines(issues, hash);
	if (!includeSource) return issueLines;

	const normalizedBlock = normalizeMermaidSource(block);
	const sourceBlock = `%% mermaid-hash: ${hash}\n${normalizedBlock}`;
	const contextBlock = `\`\`\`mermaid\n${sourceBlock}\n\`\`\``;
	return issueLines ? `${issueLines}\n\n${contextBlock}` : contextBlock;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part: any) => (part && part.type === "text" ? part.text : ""))
			.filter((part: string) => part.trim().length > 0)
			.join("\n");
	}
	return "";
}

function extractMermaidBlocks(text: string, maxBlocks = Infinity): string[] {
	const blocks: string[] = [];
	MERMAID_BLOCK_RE.lastIndex = 0;
	let match: RegExpExecArray | null = null;
	while ((match = MERMAID_BLOCK_RE.exec(text)) !== null) {
		const code = match[1]?.trim();
		if (code) blocks.push(code);
		if (blocks.length >= maxBlocks) break;
	}
	return blocks;
}

function getMermaidTypeToken(block: string): string | null {
	const lines = block.split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("%%")) continue;
		return trimmed.split(/\s+/)[0] ?? null;
	}
	return null;
}

function getSupportedMermaidType(block: string): { token: string | null; normalized: string | null } {
	const token = getMermaidTypeToken(block);
	if (!token) return { token, normalized: null };
	return { token, normalized: SUPPORTED_TYPES.get(token) ?? null };
}

function hashMermaid(block: string): string {
	return createHash("sha256").update(block).digest("hex").slice(0, 8);
}

function getCachedAscii(key: string): { ascii: string; lineCount: number } | null {
	const cached = asciiCache.get(key);
	if (!cached) return null;
	asciiCache.delete(key);
	asciiCache.set(key, cached);
	return cached;
}

function setCachedAscii(key: string, ascii: string, lineCount: number): void {
	asciiCache.set(key, { ascii, lineCount });
	if (asciiCache.size > MAX_ASCII_CACHE) {
		const oldest = asciiCache.keys().next().value as string | undefined;
		if (oldest) asciiCache.delete(oldest);
	}
}

function splitIssuesFromContent(text: string): { ascii: string; issues: MermaidIssue[] } {
	if (!text) return { ascii: "", issues: [] };

	const lines = text.split(/\r?\n/);
	const issues: MermaidIssue[] = [];
	let current: MermaidIssue | null = null;
	let i = 0;
	let inIssues = false;

	while (i < lines.length) {
		const line = lines[i];
		const match = line.match(ISSUE_LINE_RE);

		if (match) {
			inIssues = true;
			if (current) issues.push(current);
			current = { severity: match[1] as MermaidIssue["severity"], message: match[2] };
			i++;
			continue;
		}

		if (inIssues) {
			if (line.trim() === "") {
				if (current) issues.push(current);
				i++;
				break;
			}
			if (current) {
				current = { ...current, message: `${current.message}\n${line}` };
			}
			i++;
			continue;
		}

		break;
	}

	if (current && !issues.includes(current)) issues.push(current);

	const ascii = lines.slice(i).join("\n");
	if (issues.length > 0) return { ascii, issues };
	return { ascii: ascii || text, issues };
}

function getLastAssistantText(entries: SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		if (entry.message.role !== "assistant") continue;
		const text = extractText(entry.message.content);
		if (text.trim()) return text;
	}
	return null;
}

async function processBlock(
	block: string,
	blockIndex: number,
	blockLabel: string,
	parser: ((text: string) => Promise<void>) | null,
	warnParserUnavailable: (errorMessage?: string) => void,
): Promise<ProcessBlockResult> {
	const issues: MermaidIssue[] = [];
	const notifications: MermaidNotification[] = [];
	const diagramHash = hashMermaid(block);

	const addIssue = (severity: MermaidIssue["severity"], message: string) => {
		notifications.push({ message, type: severity === "error" ? "error" : "warning" });
		const key = `${diagramHash}:${severity}:${message}`;
		if (seenIssueKeys.has(key)) return;
		seenIssueKeys.set(key, true);
		if (seenIssueKeys.size > MAX_SEEN_ISSUES) {
			const oldest = seenIssueKeys.keys().next().value as string | undefined;
			if (oldest) seenIssueKeys.delete(oldest);
		}
		issues.push({ severity, message });
	};

	let parserFailed = false;
	if (parser) {
		try {
			await parser(block);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (isDomPurifyError(errorMessage)) {
				warnParserUnavailable(errorMessage);
			} else {
				parserFailed = true;
				const message = `Mermaid parse error${blockLabel}: ${errorMessage}`;
				addIssue("error", message);
			}
		}
	}

	let ascii = "";
	let lineCount = 0;
	if (parserFailed) {
		ascii = "[parse failed]";
		lineCount = 1;
	} else {
		try {
			const cached = getCachedAscii(diagramHash);
			ascii = cached?.ascii ?? renderMermaidAscii(block).trimEnd();
			lineCount = cached?.lineCount ?? (ascii ? ascii.split("\n").length : 0);
			if (!cached) setCachedAscii(diagramHash, ascii, lineCount);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const message = `Mermaid render failed${blockLabel}: ${errorMessage}`;
			addIssue("error", message);
			ascii = "[render failed]";
			lineCount = 1;
		}
	}

	return {
		diagramHash,
		details: {
			source: block,
			index: blockIndex,
			ascii,
			lineCount,
			issues: issues.length > 0 ? issues : undefined,
		},
		issues,
		notifications,
	};
}

export default function (pi: ExtensionAPI) {
	const renderMermaidMessage: MessageRenderer<MermaidDetails> = (message, { expanded }, theme) => {
		const details = message.details as MermaidDetails | undefined;
		const label = theme.fg("customMessageLabel", theme.bold("Mermaid (ASCII)"));
		const contentText = extractText(message.content);
		const fallback = splitIssuesFromContent(contentText);
		const rawAscii = details?.ascii ?? fallback.ascii;
		const lineCount = details?.lineCount ?? (rawAscii ? rawAscii.split("\n").length : 0);
		const hasOverflow = lineCount > COLLAPSED_LINES;
		const isExpanded = expanded || !hasOverflow;
		let preview = rawAscii || "";
		if (!isExpanded && rawAscii) {
			preview = rawAscii.split("\n").slice(0, COLLAPSED_LINES).join("\n");
		}
		const remainingLines = hasOverflow ? lineCount - COLLAPSED_LINES : 0;
		let text = `${label}\n${preview}`;

		if (hasOverflow && !isExpanded) {
			const hintText = `... (${remainingLines} more lines, ${keyHint("expandTools", "to expand")})`;
			text += `\n${theme.fg("muted", hintText)}`;
		}

		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));

		if (expanded && details?.source) {
			box.addChild(new Spacer(1));
			const markdownTheme = getMarkdownTheme();
			const indent = markdownTheme.codeBlockIndent ?? "  ";
			const normalizedSource = normalizeMermaidSource(details.source);
			const highlighted = markdownTheme.highlightCode?.(normalizedSource, "mermaid");
			const codeLines = highlighted ?? normalizedSource.split("\n").map((line) => markdownTheme.codeBlock(line));
			const renderedLines = [
				markdownTheme.codeBlockBorder("```mermaid"),
				...codeLines.map((line) => `${indent}${line}`),
				markdownTheme.codeBlockBorder("```"),
			].join("\n");
			box.addChild(new Text(renderedLines, 0, 0));
		}

		return box;
	};

	pi.registerMessageRenderer(MESSAGE_TYPE, renderMermaidMessage);

	const renderBlocks = async (
		blocks: string[],
		ctx: ExtensionContext,
		options: { includeSourceInContext?: boolean } = {},
	) => {
		const notify = (message: string, type: "info" | "warning" | "error") => {
			if (ctx.hasUI) ctx.ui.notify(message, type);
		};

		const warnParserUnavailable = (errorMessage?: string) => {
			if (!ctx.hasUI || mermaidParserWarned) return;
			const suffixSource = errorMessage ?? mermaidParserError;
			const suffix = suffixSource ? ` (${suffixSource})` : "";
			notify(
				`Mermaid validation isn’t usable right now${suffix}. Will try again next time; rendering anyway.`,
				"warning",
			);
			mermaidParserWarned = true;
		};

		let parser = await getMermaidParser();
		if (!parser) warnParserUnavailable();

		if (blocks.length > MAX_BLOCKS) {
			notify(`Found ${blocks.length} mermaid blocks, rendering first ${MAX_BLOCKS}.`, "warning");
		}

		for (const [index, block] of blocks.slice(0, MAX_BLOCKS).entries()) {
			const blockIndex = index + 1;
			const blockLabel = blocks.length > 1 ? ` (block ${blockIndex})` : "";
			const sourceLines = block.split(/\r?\n/);
			if (sourceLines.length > MAX_SOURCE_LINES || block.length > MAX_SOURCE_CHARS) {
				notify(
					`Mermaid block ${blockIndex} too large (${sourceLines.length} lines, ${block.length} chars).`,
					"warning",
				);
				continue;
			}

			const { token, normalized } = getSupportedMermaidType(block);
			if (!normalized) {
				const typeLabel = token ?? "unknown";
				notify(
					`pi-mermaid can't render type "${typeLabel}"${blockLabel}. Supported: ${SUPPORTED_TYPE_LABEL}.`,
					"info",
				);
				continue;
			}

			const { diagramHash, details, issues, notifications } = await processBlock(
				block,
				blockIndex,
				blockLabel,
				parser,
				warnParserUnavailable,
			);

			const includeSource = options.includeSourceInContext ?? true;
			const contextContent = buildContextContent(block, diagramHash, issues, includeSource);
			pi.sendMessage({
				customType: MESSAGE_TYPE,
				content: contextContent,
				display: true,
				details,
			});

			for (const notification of notifications) {
				notify(notification.message, notification.type);
			}
		}
	};

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };

		const text = typeof event.text === "string" ? event.text : "";
		if (!text) return { action: "continue" };

		const blocks = extractMermaidBlocks(text, MAX_BLOCKS + 1);
		if (blocks.length === 0) return { action: "continue" };

		await renderBlocks(blocks, ctx, { includeSourceInContext: blocks.length > 1 });
		return { action: "continue" };
	});

	pi.on("agent_end", async (event, ctx) => {
		let assistantText = "";
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const msg = event.messages[i];
			if (msg.role !== "assistant") continue;
			assistantText = extractText(msg.content);
			if (assistantText.trim()) break;
		}

		if (!assistantText) return;

		const blocks = extractMermaidBlocks(assistantText, MAX_BLOCKS + 1);
		if (blocks.length === 0) return;

		await renderBlocks(blocks, ctx, { includeSourceInContext: blocks.length > 1 });
	});

	pi.registerCommand("pi-mermaid", {
		description: "Render mermaid in last assistant message as ASCII",
		handler: async (_args, ctx) => {
			const lastAssistant = getLastAssistantText(ctx.sessionManager.getBranch());
			if (!lastAssistant) {
				if (ctx.hasUI) ctx.ui.notify("No assistant message found", "warning");
				return;
			}

			const blocks = extractMermaidBlocks(lastAssistant, MAX_BLOCKS + 1);
			if (blocks.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("No mermaid blocks found", "warning");
				return;
			}

			await renderBlocks(blocks, ctx, { includeSourceInContext: true });
		},
	});
}
