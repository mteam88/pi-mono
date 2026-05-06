import { describe, expect, it } from "vitest";
import {
	buildSessionContext,
	buildSessionProjection,
	type ContextRewriteEntry,
	type ContextRewriteUndoEntry,
	hashContextText,
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
} from "../../src/core/session-manager.js";

const timestamp = "2025-01-01T00:00:00Z";

function user(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	};
}

type AssistantContent = Array<
	{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
>;

function assistant(
	id: string,
	parentId: string | null,
	text: string,
	content: AssistantContent = [{ type: "text", text }],
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content,
			api: "test",
			provider: "test",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function bash(id: string, parentId: string | null, command: string, output: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "bashExecution",
			command,
			output,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		},
	};
}

function rewrite(
	id: string,
	parentId: string | null,
	rewrite: Omit<ContextRewriteEntry, "type" | "id" | "parentId" | "timestamp">,
): ContextRewriteEntry {
	return { type: "context_rewrite", id, parentId, timestamp, ...rewrite };
}

function undo(id: string, parentId: string | null, rewriteId: string): ContextRewriteUndoEntry {
	return { type: "context_rewrite_undo", id, parentId, timestamp, rewriteId };
}

function textOf(message: ReturnType<typeof buildSessionContext>["messages"][number]): string {
	switch (message.role) {
		case "user":
			return Array.isArray(message.content)
				? message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
				: message.content;
		case "assistant":
			return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		case "bashExecution":
			return message.output;
		case "contextRewrite":
			return message.text;
		case "toolResult":
			return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		case "custom":
			return typeof message.content === "string"
				? message.content
				: message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
	}
}

describe("context rewrites", () => {
	it("replaces a middle range while keeping the suffix", () => {
		const entries: SessionEntry[] = [
			user("u1", null, "start"),
			assistant("a1", "u1", "ok"),
			user("u2", "a1", "wrong path"),
			assistant("a2", "u2", "wrong details"),
			user("u3", "a2", "back to useful work"),
			rewrite("r1", "u3", {
				rewriteId: "collapse-wrong-path",
				target: { kind: "range", fromEntryId: "u2", toEntryId: "a2" },
				after: "Summary: wrong path omitted.",
			}),
			assistant("a3", "r1", "done"),
		];

		const projection = buildSessionProjection(entries, "a3");
		expect(projection.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"contextRewrite",
			"user",
			"assistant",
		]);
		expect(projection.messages.map(textOf)).toEqual([
			"start",
			"ok",
			"Summary: wrong path omitted.",
			"back to useful work",
			"done",
		]);
		expect(projection.items[2]?.sourceEntryIds).toEqual(["u2", "a2"]);
	});

	it("rewrites a bash output surface without removing command context", () => {
		const entries: SessionEntry[] = [
			user("u1", null, "run command"),
			bash("b1", "u1", "printf secret", "SECRET OUTPUT"),
			rewrite("r1", "b1", {
				target: { kind: "surface", entryId: "b1", surface: "output" },
				beforeHash: hashContextText("SECRET OUTPUT"),
				after: "[output omitted]",
			}),
		];

		const context = buildSessionContext(entries);
		const bashMessage = context.messages[1];
		expect(bashMessage?.role).toBe("bashExecution");
		if (bashMessage?.role === "bashExecution") {
			expect(bashMessage.command).toBe("printf secret");
			expect(bashMessage.output).toBe("[output omitted]");
		}
	});

	it("skips range rewrites that would orphan tool results", () => {
		const entries: SessionEntry[] = [
			user("u1", null, "run tool"),
			assistant("a1", "u1", "", [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } }]),
			{
				type: "message",
				id: "t1",
				parentId: "a1",
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "tool output" }],
					isError: false,
					timestamp: 1,
				},
			},
			rewrite("r1", "t1", {
				target: { kind: "range", fromEntryId: "a1", toEntryId: "a1" },
				after: "assistant call omitted",
			}),
		];

		expect(buildSessionContext(entries).messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
	});

	it("uses context rewrites for branch summaries created by SessionManager", () => {
		const session = SessionManager.inMemory(process.cwd());
		const first = session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "test",
			provider: "test",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});

		const summaryId = session.branchWithSummary(first, "Summary of alternate branch");
		const summaryEntry = session.getEntry(summaryId);
		expect(summaryEntry?.type).toBe("context_rewrite");
		expect(buildSessionContext(session.getEntries()).messages.map(textOf)).toEqual([
			"start",
			"Summary of alternate branch",
		]);
	});

	it("supports exact before-after edits within a text surface", () => {
		const entries: SessionEntry[] = [
			user("u1", null, "the password is hunter2"),
			rewrite("r1", "u1", {
				target: { kind: "surface", entryId: "u1", surface: "text" },
				before: "hunter2",
				after: "[redacted]",
			}),
		];

		expect(textOf(buildSessionContext(entries).messages[0])).toBe("the password is [redacted]");
	});

	it("undo entries deactivate rewrites on the current branch", () => {
		const entries: SessionEntry[] = [
			user("u1", null, "original"),
			rewrite("r1", "u1", {
				rewriteId: "edit-u1",
				target: { kind: "surface", entryId: "u1", surface: "text" },
				after: "rewritten",
			}),
			undo("u2", "r1", "edit-u1"),
		];

		expect(textOf(buildSessionContext(entries).messages[0])).toBe("original");
	});
});
