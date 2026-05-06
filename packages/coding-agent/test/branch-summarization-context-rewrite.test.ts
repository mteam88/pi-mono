import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../src/core/compaction/branch-summarization.js";
import { hashContextText, type SessionEntry } from "../src/core/session-manager.js";

const timestamp = "2025-01-01T00:00:00Z";

describe("branch summarization context rewrites", () => {
	it("keeps inserted rewrite context when the anchor is outside the collected branch", () => {
		const entries: SessionEntry[] = [
			{
				type: "context_rewrite",
				id: "r1",
				parentId: "common-ancestor",
				timestamp,
				target: { kind: "insert", afterEntryId: "common-ancestor" },
				after: "Summary from previous branch",
			},
			{
				type: "message",
				id: "u1",
				parentId: "r1",
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 1 },
			},
		];

		const preparation = prepareBranchEntries(entries);

		expect(preparation.messages.map((message) => message.role)).toEqual(["contextRewrite", "user"]);
		expect(JSON.stringify(preparation.messages)).toContain("Summary from previous branch");
	});

	it("summarizes the effective projected branch context", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "run command" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "b1",
				parentId: "u1",
				timestamp,
				message: {
					role: "bashExecution",
					command: "printf secret",
					output: "SECRET OUTPUT",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 2,
				},
			},
			{
				type: "context_rewrite",
				id: "r1",
				parentId: "b1",
				timestamp,
				target: { kind: "surface", entryId: "b1", surface: "output" },
				beforeHash: hashContextText("SECRET OUTPUT"),
				after: "[output omitted]",
			},
		];

		const preparation = prepareBranchEntries(entries);
		const bashMessage = preparation.messages.find((message) => message.role === "bashExecution");

		expect(bashMessage?.role).toBe("bashExecution");
		if (bashMessage?.role === "bashExecution") {
			expect(bashMessage.output).toBe("[output omitted]");
		}
		expect(JSON.stringify(preparation.messages)).not.toContain("SECRET OUTPUT");
	});
});
