import { api } from "./api";

/**
 * Built-in "workspace" toolset: file tools rooted at the project folder the
 * user opened for the session. They ride the same tool-calling pipeline as
 * MCP tools — exposed to the model as `workspace__<name>`, gated by the same
 * per-session permission policies — but dispatch to the sandboxed Rust
 * workspace commands instead of an MCP server.
 */

export const WORKSPACE_SERVER_ID = "workspace";
export const WORKSPACE_SERVER_NAME = "Project folder";

export type WorkspaceToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Read-only tools are auto-allowed (unless the session default is deny or
   *  an explicit per-tool override says otherwise). */
  readOnly: boolean;
};

export const WORKSPACE_TOOLS: WorkspaceToolDef[] = [
  {
    name: "list_dir",
    description:
      'List the files and folders in a directory of the project. Use path "" for the project root. Paths are relative to the project root.',
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the project root. Empty or omitted = root.",
        },
      },
    },
    readOnly: true,
  },
  {
    name: "read_file",
    description:
      "Read a text file from the project. Returns up to `limit` lines starting at line `offset` (1-based). Always read a file before editing it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        offset: { type: "integer", description: "1-based line to start from (default 1)." },
        limit: { type: "integer", description: "Max lines to return (default 400)." },
      },
      required: ["path"],
    },
    readOnly: true,
  },
  {
    name: "search_files",
    description:
      "Search file contents for a string (case-insensitive). Returns matching lines as path:line: text. Use this to locate code before reading files.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for." },
        path: {
          type: "string",
          description:
            "Restrict the search to this directory (relative). Omit for the whole project.",
        },
        max_results: { type: "integer", description: "Cap on matches returned (default 100)." },
      },
      required: ["query"],
    },
    readOnly: true,
  },
  {
    name: "find_files",
    description:
      "Find files by name. Supports * wildcards (e.g. *.rs, src/*.test.ts); a plain string matches as a substring of the filename.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Filename pattern, e.g. *.tsx or config." },
        max_results: { type: "integer", description: "Cap on paths returned (default 100)." },
      },
      required: ["pattern"],
    },
    readOnly: true,
  },
  {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact string. old_string must match the file contents exactly (including whitespace) and be unique unless replace_all is true. Read the file first and copy the text verbatim.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        old_string: { type: "string", description: "Exact text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
      },
      required: ["path", "old_string", "new_string"],
    },
    readOnly: false,
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file with the given content. Parent directories are created as needed. Prefer edit_file for changing existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
    },
    readOnly: false,
  },
];

const READ_ONLY = new Set(WORKSPACE_TOOLS.filter((t) => t.readOnly).map((t) => t.name));

export function isWorkspaceReadOnlyTool(name: string): boolean {
  return READ_ONLY.has(name);
}

/** Extra system-prompt context injected when a workspace is open, so small
 *  local models know the tools exist and how to use them. */
export function workspaceSystemNote(root: string): string {
  return [
    `You have file tools for the user's project at ${root} (the "workspace").`,
    `Use workspace__search_files / workspace__find_files to locate code, workspace__read_file to read it, and workspace__edit_file (exact unique old_string) or workspace__write_file to change it.`,
    `All paths are relative to the project root. Always read a file before editing it.`,
  ].join(" ");
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`missing required string argument: ${key}`);
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function optNum(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  // Models sometimes send numbers as strings.
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Math.floor(Number(v));
  }
  return null;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Execute a workspace tool call and flatten the result into the text content
 * of a `tool` role message. Throws on unknown tools / bad arguments — the
 * caller turns that into a "Tool execution failed" message the model sees.
 */
export async function callWorkspaceTool(
  root: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "list_dir": {
      const path = optStr(args, "path") ?? "";
      const entries = await api.workspaceList(root, path);
      if (entries.length === 0) return `${path || "(root)"} is empty`;
      const lines = entries.map((e) =>
        e.is_dir ? `${e.name}/` : `${e.name} (${fmtSize(e.size)})`,
      );
      return `${path || "(root)"} — ${entries.length} entries:\n${lines.join("\n")}`;
    }
    case "read_file": {
      const path = str(args, "path");
      const r = await api.workspaceRead(root, path, optNum(args, "offset"), optNum(args, "limit"));
      const head = `${r.path} (lines ${r.start_line}-${r.end_line} of ${r.total_lines}):`;
      const tail = r.truncated ? `\n[truncated — continue with offset=${r.end_line + 1}]` : "";
      return `${head}\n${r.content}${tail}`;
    }
    case "search_files": {
      const query = str(args, "query");
      const r = await api.workspaceSearch(
        root,
        query,
        optStr(args, "path"),
        optNum(args, "max_results"),
      );
      if (r.matches.length === 0) {
        return `no matches for "${query}" (${r.files_scanned} files scanned)`;
      }
      const lines = r.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
      const tail = r.truncated ? `\n[result cap reached — narrow the query or set path]` : "";
      return `${r.matches.length} matches for "${query}":\n${lines.join("\n")}${tail}`;
    }
    case "find_files": {
      const pattern = str(args, "pattern");
      const r = await api.workspaceFind(root, pattern, optNum(args, "max_results"));
      if (r.paths.length === 0) return `no files match "${pattern}"`;
      const tail = r.truncated ? `\n[result cap reached]` : "";
      return `${r.paths.length} files match "${pattern}":\n${r.paths.join("\n")}${tail}`;
    }
    case "edit_file": {
      const path = str(args, "path");
      const r = await api.workspaceEdit(
        root,
        path,
        str(args, "old_string"),
        str(args, "new_string"),
        args.replace_all === true,
      );
      return `Edited ${r.path} — ${r.replacements} replacement${r.replacements === 1 ? "" : "s"}`;
    }
    case "write_file": {
      const path = str(args, "path");
      const r = await api.workspaceWrite(root, path, str(args, "content"));
      return `${r.created ? "Created" : "Overwrote"} ${r.path} (${fmtSize(r.bytes)})`;
    }
    default:
      throw new Error(`unknown workspace tool: ${name}`);
  }
}
