import type { ExtensionAPI, ExtensionContext, MessageRenderer, SessionEntry } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import { Box, Spacer, Text, type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
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
const ASCII_PRESETS: Array<{ key: string; paddingX: number; boxBorderPadding: number }> = [
	{ key: "default", paddingX: 5, boxBorderPadding: 1 },
	{ key: "compact", paddingX: 3, boxBorderPadding: 1 },
	{ key: "tight", paddingX: 2, boxBorderPadding: 1 },
	{ key: "squeezed", paddingX: 1, boxBorderPadding: 0 },
];

type AsciiPreset = (typeof ASCII_PRESETS)[number];

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
const asciiCache = new Map<string, AsciiVariant>();
const asciiLinesCache = new Map<string, { lines: string[]; previewLines: string[] }>();

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

interface AsciiVariant {
	presetKey: string;
	ascii: string;
	lineCount: number;
	maxLineWidth: number;
}

interface MermaidDetails {
	source: string;
	index: number;
	ascii: string;
	lineCount: number;
	variants?: AsciiVariant[];
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

function getAsciiCacheKey(diagramHash: string, presetKey: string): string {
	return `${diagramHash}:${presetKey}`;
}

function getCachedVariant(key: string): AsciiVariant | null {
	const cached = asciiCache.get(key);
	if (!cached) return null;
	asciiCache.delete(key);
	asciiCache.set(key, cached);
	return cached;
}

function setCachedVariant(key: string, variant: AsciiVariant): void {
	asciiCache.set(key, variant);
	if (asciiCache.size > MAX_ASCII_CACHE) {
		const oldest = asciiCache.keys().next().value as string | undefined;
		if (oldest) asciiCache.delete(oldest);
	}
}

function countAsciiLines(ascii: string): number {
	if (!ascii) return 0;
	return ascii.split(/\r?\n/).length;
}

function maxAsciiLineWidth(ascii: string): number {
	if (!ascii) return 0;
	return ascii.split(/\r?\n/).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

function getCachedAsciiLines(ascii: string): { lines: string[]; previewLines: string[] } {
	if (!ascii) return { lines: [], previewLines: [] };
	const cached = asciiLinesCache.get(ascii);
	if (cached) {
		asciiLinesCache.delete(ascii);
		asciiLinesCache.set(ascii, cached);
		return cached;
	}

	const lines = ascii.split(/\r?\n/);
	const previewLines = lines.length > COLLAPSED_LINES ? lines.slice(0, COLLAPSED_LINES) : lines;
	const entry = { lines, previewLines };
	asciiLinesCache.set(ascii, entry);
	if (asciiLinesCache.size > MAX_ASCII_CACHE) {
		const oldest = asciiLinesCache.keys().next().value as string | undefined;
		if (oldest) asciiLinesCache.delete(oldest);
	}
	return entry;
}

function renderAsciiVariant(block: string, diagramHash: string, preset: AsciiPreset): AsciiVariant {
	const cacheKey = getAsciiCacheKey(diagramHash, preset.key);
	const cached = getCachedVariant(cacheKey);
	if (cached) return cached;

	const ascii = renderMermaidAscii(block, {
		paddingX: preset.paddingX,
		boxBorderPadding: preset.boxBorderPadding,
	}).trimEnd();
	const lineCount = countAsciiLines(ascii);
	const maxLineWidth = maxAsciiLineWidth(ascii);
	getCachedAsciiLines(ascii);
	const variant: AsciiVariant = { presetKey: preset.key, ascii, lineCount, maxLineWidth };
	setCachedVariant(cacheKey, variant);
	return variant;
}

function selectAsciiVariant(
	width: number,
	variants: AsciiVariant[] | undefined,
	fallbackAscii: string,
	fallbackLineCount: number,
): { ascii: string; lineCount: number; maxLineWidth: number; clipped: boolean } {
	const safeWidth = Math.max(1, width);
	if (variants && variants.length > 0) {
		for (const variant of variants) {
			if (variant.maxLineWidth <= safeWidth) {
				return { ...variant, clipped: false };
			}
		}
		const tightest = variants[variants.length - 1];
		return { ...tightest, clipped: tightest.maxLineWidth > safeWidth };
	}

	const maxLineWidth = maxAsciiLineWidth(fallbackAscii);
	const lineCount = fallbackLineCount || countAsciiLines(fallbackAscii);
	return { ascii: fallbackAscii, lineCount, maxLineWidth, clipped: maxLineWidth > safeWidth };
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
	let variants: AsciiVariant[] | undefined;
	if (parserFailed) {
		ascii = "[parse failed]";
		lineCount = 1;
	} else {
		try {
			variants = [];
			for (const preset of ASCII_PRESETS) {
				try {
					variants.push(renderAsciiVariant(block, diagramHash, preset));
				} catch (error) {
					if (preset.key === "squeezed") continue;
					const errorMessage = error instanceof Error ? error.message : String(error);
					const message = `Mermaid render failed${blockLabel} (${preset.key}): ${errorMessage}`;
					notifications.push({ message, type: "warning" });
				}
			}
			if (variants.length === 0) {
				throw new Error("No ASCII variants rendered");
			}
			ascii = variants[0].ascii;
			lineCount = variants[0].lineCount;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const message = `Mermaid render failed${blockLabel}: ${errorMessage}`;
			addIssue("error", message);
			ascii = "[render failed]";
			lineCount = 1;
			variants = undefined;
		}
	}

	return {
		diagramHash,
		details: {
			source: block,
			index: blockIndex,
			ascii,
			lineCount,
			variants: variants && variants.length > 0 ? variants : undefined,
			issues: issues.length > 0 ? issues : undefined,
		},
		issues,
		notifications,
	};
}

export default function (pi: ExtensionAPI) {
	const renderMermaidMessage: MessageRenderer<MermaidDetails> = (message, { expanded }, theme) => {
		const details = message.details as MermaidDetails | undefined;
		const contentText = extractText(message.content);
		const fallback = splitIssuesFromContent(contentText);
		const fallbackAscii = details?.ascii ?? fallback.ascii;
		const fallbackLineCount = details?.lineCount ?? countAsciiLines(fallbackAscii);
		const variants = details?.variants;

		const asciiComponent: Component = {
			render: (width) => {
				const contentWidth = Math.max(1, width);
				const label = theme.fg("customMessageLabel", theme.bold("Mermaid (ASCII)"));
				const selection = selectAsciiVariant(contentWidth, variants, fallbackAscii, fallbackLineCount);
				const asciiLines = getCachedAsciiLines(selection.ascii);
				const hasOverflow = selection.lineCount > COLLAPSED_LINES;
				const isExpanded = expanded || !hasOverflow;
				const visibleLines = isExpanded ? asciiLines.lines : asciiLines.previewLines;
				const needsClip = selection.maxLineWidth > contentWidth;
				const clipAsciiLine = needsClip
					? (line: string) => truncateToWidth(line, contentWidth, "")
					: (line: string) => line;

				const lines: string[] = [];
				lines.push(truncateToWidth(label, contentWidth));
				for (const line of visibleLines) {
					lines.push(clipAsciiLine(line));
				}

				if (hasOverflow && !isExpanded) {
					const remainingLines = selection.lineCount - COLLAPSED_LINES;
					const hintText = `... (${remainingLines} more lines, ${keyHint("expandTools", "to expand")})`;
					lines.push(truncateToWidth(theme.fg("muted", hintText), contentWidth));
				}

				if (selection.clipped) {
					const hintText = "... (clipped to fit width; widen terminal to view full diagram)";
					lines.push(truncateToWidth(theme.fg("muted", hintText), contentWidth));
				}

				return lines;
			},
			invalidate: () => {},
		};

		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
		box.addChild(asciiComponent);

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
				`Mermaid parser validation isn’t usable right now${suffix}. Will try again next time; rendering anyway.`,
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
