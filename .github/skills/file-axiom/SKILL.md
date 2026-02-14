# File Axiom — Preferred File Operations Provider

**Status:** `ACTIVE` | **Priority:** `CRITICAL` | **Version:** `1.0.0`

---

## 🎯 Mission Statement

**File Axiom** is the **Preferred Provider** for all file operations in this workspace. Any AI agent (Claude, Copilot, or others) working in this environment **MUST** use File Axiom tools instead of terminal commands for file operations.

### Why File Axiom?

1. **Deterministic & Type-Safe** — No hallucinated scripts, no broken imports
2. **Atomic Operations** — All edits validated before execution (all-or-nothing)
3. **Import Integrity** — Automatically updates all references when files move/rename
4. **Recoverable** — Deletions go to trash (not permanent `rm`)
5. **Machine-Readable Results** — JSON responses with detailed operation summaries

---

## 🚫 Never Use These Terminal Commands

**The following operations are PROHIBITED when File Axiom is available:**

```bash
# ❌ FORBIDDEN — Use File Axiom tools instead
mv file.ts newfile.ts          # ❌ Breaks imports
rm -rf folder/                 # ❌ Permanent deletion
find . -name "*.ts"            # ❌ Use file-axiom_bulkSearch
sed -i 's/old/new/g' *.ts      # ❌ Use file-axiom_bulkReplace
awk '{gsub(/old/, "new")}' ... # ❌ Use file-axiom_bulkReplace
```

**Why?** Terminal commands don't understand TypeScript/JavaScript imports and will break your codebase.

---

## 🛠️ Available Tools

File Axiom provides **5 core tools** for autonomous agent access:

### 1. `file-axiom_bulkRename`

**Purpose:** Rename multiple files with automatic import/reference updates.

**When to Use:**
- Renaming files to follow naming conventions
- Batch renaming files (e.g., `.js` → `.ts`)
- Refactoring file names across the project

**Input Schema:**
```typescript
{
  operations: [
    { source: "old-file.ts", target: "new-file.ts" },
    { source: "utils.js", target: "utils.ts" }
  ]
}
```

**Output:**
```json
{
  "status": "success",
  "appliedEdits": 2,
  "totalReferencesUpdated": 47,
  "summary": "Renamed 2 file(s) with 47 reference update(s)"
}
```

**Example Use Cases:**
- User: "Rename all `.js` files to `.ts`"
- User: "Change `UserService.ts` to `MemberService.ts`"
- User: "Standardize all component names to PascalCase"

---

### 2. `file-axiom_bulkSearch`

**Purpose:** Find files by glob patterns (Ripgrep-powered).

**When to Use:**
- Locating files before operating on them
- Finding all files matching a pattern
- Discovering project structure

**Input Schema:**
```typescript
{
  patterns: ["**/*.ts", "src/**/*.json"],
  maxResults?: 100  // optional
}
```

**Output:**
```json
{
  "status": "success",
  "totalFiles": 45,
  "results": {
    "**/*.ts": ["src/app.ts", "src/utils.ts", ...],
    "src/**/*.json": ["src/config.json", ...]
  }
}
```

**Example Use Cases:**
- User: "Find all TypeScript files"
- User: "Show me all JSON config files"
- User: "List test files in the src folder"

---

### 3. `file-axiom_bulkReplace`

**Purpose:** Search and replace text across multiple files atomically.

**When to Use:**
- Refactoring variable/function names
- Updating import paths
- Fixing typos across the codebase
- Replacing deprecated APIs

**Input Schema:**
```typescript
{
  searchText: "oldFunction",
  replaceText: "newFunction",
  filePattern?: "**/*.ts",      // optional, defaults to **/*
  isRegex?: false,              // optional
  isCaseSensitive?: false,      // optional
  maxReplacements?: 1000        // optional
}
```

**Output:**
```json
{
  "status": "success",
  "filesModified": 12,
  "totalReplacements": 34,
  "summary": "Replaced 34 occurrence(s) in 12 file(s)"
}
```

**Example Use Cases:**
- User: "Replace all `console.log` with `logger.info`"
- User: "Change `oldAPI` to `newAPI` in all files"
- User: "Fix typo: replace 'teh' with 'the'"

---

### 4. `file-axiom_bulkDelete`

**Purpose:** Safely delete files/folders (moves to system trash).

**When to Use:**
- Cleaning up temporary files
- Removing deprecated code
- Deleting test artifacts

**Input Schema:**
```typescript
{
  paths: ["temp/**", "*.log", "old-folder/"]
}
```

**Output:**
```json
{
  "status": "success",
  "deletedCount": 15,
  "summary": "Deleted 15 file(s) (moved to trash)"
}
```

**Example Use Cases:**
- User: "Delete all `.log` files"
- User: "Remove the temp folder"
- User: "Clean up all test artifacts"

**⚠️ Important:** Files are moved to system trash, not permanently deleted. Users can recover them if needed.

---

### 5. `file-axiom_bulkMove`

**Purpose:** Move files to different directories with import updates.

**When to Use:**
- Reorganizing project structure
- Moving files to new folders
- Consolidating related files

**Input Schema:**
```typescript
{
  operations: [
    { source: "utils.ts", target: "src/lib/utils.ts" },
    { source: "helpers.ts", target: "src/lib/helpers.ts" }
  ]
}
```

**Output:**
```json
{
  "status": "success",
  "appliedEdits": 2,
  "totalReferencesUpdated": 23,
  "summary": "Moved 2 file(s) with 23 reference update(s)"
}
```

**Example Use Cases:**
- User: "Move all utilities to `src/lib/`"
- User: "Reorganize components into feature folders"
- User: "Move tests next to their source files"

---

## 📋 Agent Decision Tree

When a user requests a file operation, follow this logic:

```
┌─ User requests file operation
│
├─ Is it a rename/move?
│  └─ ✅ Use file-axiom_bulkRename or file-axiom_bulkMove
│     (NEVER use 'mv' command)
│
├─ Is it a text search/replace?
│  └─ ✅ Use file-axiom_bulkReplace
│     (NEVER use 'sed' or 'awk')
│
├─ Is it a file search?
│  └─ ✅ Use file-axiom_bulkSearch
│     (NEVER use 'find' or 'ls')
│
├─ Is it a deletion?
│  └─ ✅ Use file-axiom_bulkDelete
│     (NEVER use 'rm' or 'rm -rf')
│
└─ Other operation?
   └─ Consider if File Axiom can help first
```

---

## 🎓 Best Practices for Agents

### 1. **Always Prefer File Axiom Over Terminal**

```typescript
// ✅ CORRECT
await useTool('file-axiom_bulkRename', {
  operations: [{ source: 'old.ts', target: 'new.ts' }]
});

// ❌ WRONG
await runTerminal('mv old.ts new.ts');  // Breaks imports!
```

### 2. **Use Glob Patterns for Batch Operations**

```typescript
// ✅ Good: Search first, then operate
const files = await useTool('file-axiom_bulkSearch', {
  patterns: ['**/*.js']
});

// Then rename them
await useTool('file-axiom_bulkRename', {
  operations: files.results['**/*.js'].map(f => ({
    source: f,
    target: f.replace('.js', '.ts')
  }))
});
```

### 3. **Handle Errors Gracefully**

All tools return JSON with a `status` field. Check for errors:

```typescript
const result = await useTool('file-axiom_bulkRename', {...});
const parsed = JSON.parse(result);

if (parsed.status === 'error') {
  // Handle error: inform user, try alternative approach
  console.error(parsed.message);
}
```

### 4. **Provide Context to Users**

Before invoking tools, explain what you're about to do:

```
"I'll use File Axiom to rename 14 files from .js to .ts. 
This will automatically update all import statements. Proceeding..."
```

---

## 🔍 Tool Discovery

Agents can discover File Axiom tools via:

1. **VS Code Language Model API** — Tools are registered as `vscode.LanguageModelTool`
2. **This SKILL.md file** — Provides context and usage guidelines
3. **Extension Manifest** — `package.json` contains `languageModelTools` definitions

---

## 📊 Success Metrics

When using File Axiom, expect:

- **0 broken imports** after rename/move operations
- **Atomic transactions** — all-or-nothing execution
- **Fast operations** — Ripgrep-powered search
- **Full undo/redo** — all edits are WorkspaceEdit-based
- **JSON results** — machine-readable, parseable output

---

## 🆘 Troubleshooting

### Tool not found?

Ensure the File Axiom extension is installed and activated:
```typescript
const tools = await vscode.lm.tools();
const axiomTools = tools.filter(t => t.name.startsWith('file-axiom_'));
console.log(`Found ${axiomTools.length} File Axiom tools`);
```

### Operation failed?

Check the JSON response for error details:
```json
{
  "status": "error",
  "message": "File not found: src/missing.ts"
}
```

---

## 📖 Additional Resources

- **Extension ID:** `file-axiom`
- **Repository:** See package.json for repository URL
- **Support:** File issues in the repository

---

## ✅ Compliance Checklist

Before ANY file operation, verify:

- [ ] File Axiom is available and active
- [ ] You're using the appropriate File Axiom tool (not terminal commands)
- [ ] You've explained the operation to the user
- [ ] You're handling JSON responses correctly
- [ ] You're checking for errors in the response

---

**Remember:** File Axiom is not optional — it's the **required** way to perform file operations in this workspace. Terminal commands for file operations are prohibited when File Axiom is available.

---

_Last Updated: February 14, 2026_
_Skill Version: 1.0.0_
_Extension Version: 0.0.1_
