import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "./api";
import {
  WORKSPACE_TOOLS,
  callWorkspaceTool,
  isWorkspaceReadOnlyTool,
  workspaceSystemNote,
} from "./workspaceTools";

const ROOT = "C:\\proj";

describe("workspace tool definitions", () => {
  it("marks browse tools read-only and mutating tools not", () => {
    expect(isWorkspaceReadOnlyTool("read_file")).toBe(true);
    expect(isWorkspaceReadOnlyTool("list_dir")).toBe(true);
    expect(isWorkspaceReadOnlyTool("search_files")).toBe(true);
    expect(isWorkspaceReadOnlyTool("find_files")).toBe(true);
    expect(isWorkspaceReadOnlyTool("edit_file")).toBe(false);
    expect(isWorkspaceReadOnlyTool("write_file")).toBe(false);
  });

  it("every tool has an object schema (llama.cpp requires it)", () => {
    for (const t of WORKSPACE_TOOLS) {
      expect(t.parameters).toMatchObject({ type: "object" });
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it("system note mentions the root and the tool prefix", () => {
    const note = workspaceSystemNote(ROOT);
    expect(note).toContain(ROOT);
    expect(note).toContain("workspace__");
  });
});

describe("callWorkspaceTool dispatch + formatting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("list_dir formats dirs with a trailing slash and files with sizes", async () => {
    vi.spyOn(api, "workspaceList").mockResolvedValue([
      { name: "src", is_dir: true, size: 0 },
      { name: "main.rs", is_dir: false, size: 2048 },
    ]);
    const out = await callWorkspaceTool(ROOT, "list_dir", {});
    expect(api.workspaceList).toHaveBeenCalledWith(ROOT, "");
    expect(out).toContain("src/");
    expect(out).toContain("main.rs (2.0 KB)");
  });

  it("read_file passes the window through and reports truncation", async () => {
    vi.spyOn(api, "workspaceRead").mockResolvedValue({
      path: "src/main.rs",
      total_lines: 100,
      start_line: 1,
      end_line: 40,
      truncated: true,
      content: "fn main() {}\n",
    });
    const out = await callWorkspaceTool(ROOT, "read_file", {
      path: "src/main.rs",
      offset: "1",
      limit: 40,
    });
    // String-typed numbers from the model are coerced.
    expect(api.workspaceRead).toHaveBeenCalledWith(ROOT, "src/main.rs", 1, 40);
    expect(out).toContain("src/main.rs (lines 1-40 of 100):");
    expect(out).toContain("fn main() {}");
    expect(out).toContain("offset=41");
  });

  it("search_files renders path:line: text rows", async () => {
    vi.spyOn(api, "workspaceSearch").mockResolvedValue({
      matches: [{ path: "src/a.ts", line: 3, text: "const x = 1;" }],
      truncated: false,
      files_scanned: 10,
    });
    const out = await callWorkspaceTool(ROOT, "search_files", { query: "x" });
    expect(api.workspaceSearch).toHaveBeenCalledWith(ROOT, "x", null, null);
    expect(out).toContain("src/a.ts:3: const x = 1;");
  });

  it("search_files reports zero matches with scan count", async () => {
    vi.spyOn(api, "workspaceSearch").mockResolvedValue({
      matches: [],
      truncated: false,
      files_scanned: 42,
    });
    const out = await callWorkspaceTool(ROOT, "search_files", { query: "ghost" });
    expect(out).toContain("no matches");
    expect(out).toContain("42 files scanned");
  });

  it("find_files lists paths and flags the cap", async () => {
    vi.spyOn(api, "workspaceFind").mockResolvedValue({
      paths: ["src/a.rs", "src/b.rs"],
      truncated: true,
    });
    const out = await callWorkspaceTool(ROOT, "find_files", { pattern: "*.rs" });
    expect(out).toContain("src/a.rs");
    expect(out).toContain("result cap");
  });

  it("edit_file forwards replace_all and summarizes replacements", async () => {
    const spy = vi.spyOn(api, "workspaceEdit").mockResolvedValue({
      path: "src/a.ts",
      replacements: 2,
    });
    const out = await callWorkspaceTool(ROOT, "edit_file", {
      path: "src/a.ts",
      old_string: "foo",
      new_string: "bar",
      replace_all: true,
    });
    expect(spy).toHaveBeenCalledWith(ROOT, "src/a.ts", "foo", "bar", true);
    expect(out).toBe("Edited src/a.ts — 2 replacements");
  });

  it("write_file distinguishes created from overwritten", async () => {
    vi.spyOn(api, "workspaceWrite").mockResolvedValue({
      path: "new.txt",
      bytes: 5,
      created: true,
    });
    const out = await callWorkspaceTool(ROOT, "write_file", { path: "new.txt", content: "hello" });
    expect(out).toContain("Created new.txt");
  });

  it("throws on a missing required argument and on unknown tools", async () => {
    await expect(callWorkspaceTool(ROOT, "read_file", {})).rejects.toThrow(/path/);
    await expect(callWorkspaceTool(ROOT, "rm_rf", {})).rejects.toThrow(/unknown workspace tool/);
  });
});
