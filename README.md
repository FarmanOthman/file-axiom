# File Axiom

> **AgentLink Files** - A specialized sidecar for AI Agents. Empowers agents to find, move, and rename files using deterministic APIs instead of probabilistic script generation. **Zero hallucinations, zero broken imports.**

## ⚠️ Current Status (Feb 2026)

**✅ Working**: Direct chat participant (`@axiom`) - Fully functional  
**⏳ Experimental**: Agent mode (`@workspace`) - VS Code 1.109.x has incomplete tool discovery (see [PLATFORM_STATUS.md](PLATFORM_STATUS.md))

## Why File Axiom?

When AI agents need to refactor code, they typically generate shell scripts (`mv`, `sed`, `rm`) — but this is error-prone:
- ❌ Scripts can break imports and references
- ❌ No atomic operations (partial failures corrupt projects)  
- ❌ No validation before execution
- ❌ Hallucinated paths cause permanent damage

**File Axiom solves this** by providing agents with **deterministic file operation tools** that integrate with VS Code's language services.

## ✨ Features

### 🤖 Autonomous Agent Tools (VS Code 2026+)

Five production-ready tools for Copilot Agents and the VS Code Agent ecosystem:

| Tool | Purpose | Key Benefit |
|------|---------|-------------|
| **`file-axiom_bulkRename`** | Rename multiple files | Atomic import updating |
| **`file-axiom_bulkSearch`** | Find files by pattern | Instant Ripgrep-powered search |
| **`file-axiom_bulkReplace`** | Search & replace text | Atomic multi-file updates |
| **`file-axiom_bulkDelete`** | Remove files safely | Trash (recoverable) |
| **`file-axiom_bulkMove`** | Relocate files | Preserves import relationships |

### 💬 Interactive Chat Participant

Use `@axiom` for direct file operations:

```
@axiom find *.ts
@axiom rename src/old.ts to src/new.ts  
@axiom replace "oldName" with "newName" in **/*.js
@axiom delete temp/**/*.log
```

### 🔧 Comprehensive Commands

- **find** - Search files by glob patterns
- **rename** - Rename with import updates
- **list** - List directory contents
- **duplicate** - Copy files/folders
- **move** - Move with reference tracking
- **delete** - Safe trash deletion
- **info** - File metadata (size, dates, lines)
- **findText/grep** - Search text in files
- **chmod** - Change permissions (Unix/macOS)
- **symlink** - Create symbolic links
- **Direct Usage (Reliable - ✅ Works Now)

1. **Install** File Axiom in VS Code Insiders (1.109.0+)
2. **Open Copilot Chat** (Cmd/Ctrl+Alt+I)
3. **Type `@axiom`** followed by your command:
   ```
   @axiom rename src/old.ts to src/new.ts
   @axiom find **/*.{ts,js}
   @axiom replace "oldName" with "newName" in **/*.ts
   @axiom delete **/*.log
   @axiom move src/util.ts to src/utils/util.ts
   ```

All operations update imports and references automatically!

### Agent Mode (Experimental - ⏳ Platform Limitation)

Agent autonomous discovery (`@workspace`) is **not yet working** in VS Code 1.109.x due to missing embeddings infrastructure.

**Status**: Language Model Tools are correctly registered but agents cannot discover them. See [PLATFORM_STATUS.md](PLATFORM_STATUS.md) for technical details.

**When working, you could write**:
```
@workspace rename all .js files to .ts while preserving imports
```

**For now, use**:
```
@axiom rename all .js files to .ts
Type `@axiom` to invoke
3. Use commands:
   ```
   @axiom find **/*.{ts,js}
   @axiom rename src/utils/helper.ts to src/utils/helpers.ts
   ```

## 📋 Requirements

- **VS Code Insiders 1.109.0+** (for agent mode) or **VS Code 1.90+** (for chat mode)
- **Active Copilot subscription** (for agent/chat features)
- **Git** (recommended for version control safety)

## 🎯 Use Cases

### Agent-Driven Refactoring

**Prompt:** `@workspace migrate all .js files in src/ to TypeScript`

**What File Axiom does:**
1. Searches for `src/**/*.js` (using `bulkSearch`)
2. Generates rename operations (`.js` → `.ts`)
3. Shows confirmation with file list
4. Executes atomic rename with import updates
5. Returns success count and reference updates

### Safe Cleanup

**Prompt:** `@workspace delete all node modules except the root`

**What File Axiom does:**
1. Finds nested `node_modules` directories
2. Excludes workspace root
3. Shows preview of deletions
4. Moves to system trash (recoverable)
5. No terminal `rm -rf` risks!

### Global Find & Replace

**Prompt:** `@workspace update all API endpoints from v1 to v2`

**What File Axiom does:**
1. Searches text: `/api/v1/` in codebase
2. Replaces with `/api/v2/` 
3. Batches all changes in single WorkspaceEdit
4. Full undo/redo support
5. Returns files modified count

## 🛠️ Configuration

No configuration needed! File Axiom works out-of-the-box with sensible defaults:

- Excludes `node_modules`, `dist`, `.git` automatically
- Uses VS Code's language services for reference tracking
- Leverages Ripgrep for fast file searching
- Integrates with system trash for safe deletion

## 🧪 Testing

## 🧪 Testing

See [AGENT_TESTING.md](AGENT_TESTING.md) for comprehensive testing instructions.

**Quick Test:**
```
@workspace find all typescript files using file axiom
```

**Check Output Panel:**
- View → Output → "File Axiom (Extension Host)"
- Should see 5 registered tools

## 📚 Documentation

- **[AGENT_TESTING.md](AGENT_TESTING.md)** - Testing guide for agent integration
- **[.github/skills/file-axiom/SKILL.md](.github/skills/file-axiom/SKILL.md)** - Agent capability reference

## ⚠️ Known Issues

1. **Embeddings Cache 404** - Harmless warnings during extension host startup. Local tool definitions are used.
2. **First Tool Discovery** - May take 2-3 seconds for agent to index tools on first use.
3. **Confirmation Required** - All file operations require user approval (security feature, cannot be disabled).

## 🔐 Security

File Axiom is safe by design:

- ✅ All operations require user confirmation
- ✅ Atomic execution (all-or-nothing)
- ✅ Files moved to trash (recoverable)
- ✅ No network requests or telemetry
- ✅ Validation before execution
- ✅ Works within VS Code sandbox

## 🤝 Contributing

Issues and PRs welcome! File Axiom is built for the AI agent ecosystem.

## 📄 License

MIT

## 🙏 Credits

Built with:
- **VS Code Language Model API** - Agent tool integration
- **VS Code Workspace API** - Reference tracking
- **Ripgrep** - Lightning-fast file search

---

**Made for the 2026 VS Code Agent Ecosystem** 🚀

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
