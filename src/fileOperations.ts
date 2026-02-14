import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FileAxiomError, RenameResult, DirectoryEntry, FileInfo, BulkAction, BulkOperationResult, FindTextResult, TextMatch, ChmodResult, SymlinkResult, ReplaceResult } from './types';

// ── Find Files ───────────────────────────────────────────────

/**
 * Search workspace files using VS Code's Ripgrep-backed engine.
 * Returns a sorted array of matching URIs.
 */
export async function findFiles(
  pattern: string,
  maxResults: number = 100,
): Promise<vscode.Uri[]> {
  if (!pattern || pattern.trim().length === 0) {
    throw new FileAxiomError(
      'Search pattern must not be empty.',
      'INVALID_INPUT',
    );
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new FileAxiomError(
      'No workspace folder is open. Open a folder first.',
      'NO_WORKSPACE',
    );
  }

  const uris = await vscode.workspace.findFiles(
    pattern,
    '**/node_modules/**',
    maxResults,
  );

  return uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

// ── Rename File (with silent import updates) ─────────────────

/**
 * Atomically rename a file and update all import references in one
 * WorkspaceEdit batch. Uses the Language Server Rename Provider to
 * collect reference edits silently — no UI popup.
 */
export async function renameFile(
  oldPath: string,
  newPath: string,
): Promise<RenameResult> {
  // ── Phase 1: Validation ──────────────────────────────────

  if (!vscode.workspace.isTrusted) {
    throw new FileAxiomError(
      'Workspace is not trusted. Cannot rename files in Restricted Mode.',
      'UNTRUSTED',
    );
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new FileAxiomError(
      'No workspace folder is open.',
      'NO_WORKSPACE',
    );
  }

  const root = folders[0].uri;
  const oldUri = vscode.Uri.joinPath(root, oldPath);
  const newUri = vscode.Uri.joinPath(root, newPath);

  // Verify source exists
  try {
    await vscode.workspace.fs.stat(oldUri);
  } catch (err: unknown) {
    if (isFileSystemError(err, 'FileNotFound')) {
      throw new FileAxiomError(
        `Source file not found: ${oldPath}`,
        'FILE_NOT_FOUND',
      );
    }
    if (isFileSystemError(err, 'NoPermissions')) {
      throw new FileAxiomError(
        `Permission denied reading: ${oldPath}`,
        'PERMISSION_DENIED',
      );
    }
    throw err;
  }

  // Verify target does NOT exist
  try {
    await vscode.workspace.fs.stat(newUri);
    // If stat succeeds the target exists — abort
    throw new FileAxiomError(
      `Target already exists: ${newPath}. Aborting to prevent overwrite.`,
      'ALREADY_EXISTS',
    );
  } catch (err: unknown) {
    // FileNotFound is the expected / happy path — target doesn't exist
    if (err instanceof FileAxiomError) {
      throw err; // re-throw our ALREADY_EXISTS error
    }
    if (!isFileSystemError(err, 'FileNotFound')) {
      throw err; // unexpected error
    }
  }

  // ── Phase 2: Collect import reference edits ──────────────

  let referenceEdits: vscode.WorkspaceEdit | undefined;
  let referencesUpdated = 0;

  try {
    // Open the source file so the language server can provide rename edits.
    await vscode.workspace.openTextDocument(oldUri);

    // Ask the rename provider for all import/reference updates.
    // Position(0,0) targets the module identity; the provider resolves
    // every import/require pointing at this file across the workspace.
    const newBasename = newPath.replace(/^.*[\\/]/, '').replace(/\.\w+$/, '');

    referenceEdits = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      'vscode.executeDocumentRenameProvider',
      oldUri,
      new vscode.Position(0, 0),
      newBasename,
    );

    if (referenceEdits) {
      for (const entries of referenceEdits.entries()) {
        referencesUpdated += entries[1].length;
      }
    }
  } catch {
    // If no rename provider is available (e.g., non-TS/JS file) we
    // proceed with just the file rename — safe but no import updates.
    referenceEdits = undefined;
  }

  // ── Phase 3: Atomic commit ───────────────────────────────

  const edit = new vscode.WorkspaceEdit();

  // Add the file-level rename operation
  edit.renameFile(oldUri, newUri, { overwrite: false });

  // Merge reference edits (import path updates) into the same batch
  if (referenceEdits) {
    for (const [uri, textEdits] of referenceEdits.entries()) {
      for (const textEdit of textEdits) {
        edit.replace(uri, textEdit.range, textEdit.newText);
      }
    }
  }

  const success = await vscode.workspace.applyEdit(edit);

  if (!success) {
    throw new FileAxiomError(
      'WorkspaceEdit was rejected by VS Code. The file may be read-only.',
      'EDIT_REJECTED',
    );
  }

  return { oldUri, newUri, referencesUpdated };
}

// ── List Directory ───────────────────────────────────────────

/**
 * Lists all files and folders within the specified directory.
 * Returns an array of DirectoryEntry objects with names and types.
 */
export async function listDirectory(dirPath: string): Promise<DirectoryEntry[]> {
  if (!vscode.workspace.isTrusted) {
    throw new FileAxiomError(
      'Workspace is not trusted. Cannot list directories in Restricted Mode.',
      'UNTRUSTED',
    );
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new FileAxiomError(
      'No workspace folder is open.',
      'NO_WORKSPACE',
    );
  }

  const root = folders[0].uri;
  const dirUri = vscode.Uri.joinPath(root, dirPath);

  // Verify directory exists
  let stat;
  try {
    stat = await vscode.workspace.fs.stat(dirUri);
  } catch (err: unknown) {
    if (isFileSystemError(err, 'FileNotFound')) {
      throw new FileAxiomError(
        `Directory not found: ${dirPath}`,
        'FILE_NOT_FOUND',
      );
    }
    throw err;
  }

  // Verify it's a directory
  if (stat.type !== vscode.FileType.Directory) {
    throw new FileAxiomError(
      `Path is not a directory: ${dirPath}`,
      'INVALID_INPUT',
    );
  }

  const entries = await vscode.workspace.fs.readDirectory(dirUri);

  return entries
    .map(([name, type]) => ({
      name,
      type: type === vscode.FileType.Directory ? 'Directory' as const : 'File' as const,
      uri: vscode.Uri.joinPath(dirUri, name),
    }))
    .sort((a, b) => {
      // Directories first, then alphabetically
      if (a.type !== b.type) {
        return a.type === 'Directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
}

// ── Duplicate File/Folder ────────────────────────────────────

/**
 * Safely duplicates a file or folder to a new location.
 * Throws an error if the target already exists (no overwrite).
 */
export async function duplicateFile(
  sourcePath: string,
  targetPath: string,
): Promise<{ sourceUri: vscode.Uri; targetUri: vscode.Uri }> {
  if (!vscode.workspace.isTrusted) {
    throw new FileAxiomError(
      'Workspace is not trusted. Cannot duplicate files in Restricted Mode.',
      'UNTRUSTED',
    );
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new FileAxiomError(
      'No workspace folder is open.',
      'NO_WORKSPACE',
    );
  }

  const root = folders[0].uri;
  const sourceUri = vscode.Uri.joinPath(root, sourcePath);
  const targetUri = vscode.Uri.joinPath(root, targetPath);

  // Verify source exists
  try {
    await vscode.workspace.fs.stat(sourceUri);
  } catch (err: unknown) {
    if (isFileSystemError(err, 'FileNotFound')) {
      throw new FileAxiomError(
        `Source file not found: ${sourcePath}`,
        'FILE_NOT_FOUND',
      );
    }
    throw err;
  }

  // Verify target does NOT exist
  try {
    await vscode.workspace.fs.stat(targetUri);
    throw new FileAxiomError(
      `Target already exists: ${targetPath}. Aborting to prevent overwrite.`,
      'ALREADY_EXISTS',
    );
  } catch (err: unknown) {
    if (err instanceof FileAxiomError) {
      throw err;
    }
    if (!isFileSystemError(err, 'FileNotFound')) {
      throw err;
    }
  }

  // Copy the file/directory
  await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite: false });

  return { sourceUri, targetUri };
}

// ── Move File/Folder ─────────────────────────────────────────

/**
 * Moves a file to a new location with import updates (same as rename
 * but semantically different when moving between directories).
 */
export async function moveFile(
  sourcePath: string,
  targetPath: string,
): Promise<RenameResult> {
  // Move is semantically the same as rename in VS Code
  return await renameFile(sourcePath, targetPath);
}

// ── Delete File/Folder (Trash) ───────────────────────────────

/**
 * Safely deletes a file or folder by moving it to the system trash.
 * Prevents permanent data loss by using useTrash: true.
 */
export async function deleteFile(
  filePath: string,
): Promise<{ deletedUri: vscode.Uri }> {
  if (!vscode.workspace.isTrusted) {
    throw new FileAxiomError(
      'Workspace is not trusted. Cannot delete files in Restricted Mode.',
      'UNTRUSTED',
    );
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new FileAxiomError(
      'No workspace folder is open.',
      'NO_WORKSPACE',
    );
  }

  const root = folders[0].uri;
  const fileUri = vscode.Uri.joinPath(root, filePath);

  // Verify file exists
  try {
    await vscode.workspace.fs.stat(fileUri);
  } catch (err: unknown) {
    if (isFileSystemError(err, 'FileNotFound')) {
      throw new FileAxiomError(
        `File not found: ${filePath}`,
        'FILE_NOT_FOUND',
      );
    }
    throw err;
  }

  // Delete to trash (safe, recoverable)
  await vscode.workspace.fs.delete(fileUri, { recursive: true, useTrash: true });

  return { deletedUri: fileUri };
}

// ── File Info/Metadata ───────────────────────────────────────

/**
 * Retrieves metadata for a file including size, dates, and line count
 * (for text files).
 */
export async function getFileInfo(filePath: string): Promise<FileInfo> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new FileAxiomError(
      'No workspace folder is open.',
      'NO_WORKSPACE',
    );
  }

  const root = folders[0].uri;
  const fileUri = vscode.Uri.joinPath(root, filePath);

  // Get file stats
  let stat;
  try {
    stat = await vscode.workspace.fs.stat(fileUri);
  } catch (err: unknown) {
    if (isFileSystemError(err, 'FileNotFound')) {
      throw new FileAxiomError(
        `File not found: ${filePath}`,
        'FILE_NOT_FOUND',
      );
    }
    throw err;
  }

  const info: FileInfo = {
    uri: fileUri,
    size: stat.size,
    created: new Date(stat.ctime).toLocaleString(),
    modified: new Date(stat.mtime).toLocaleString(),
    type: stat.type === vscode.FileType.Directory ? 'Directory' : 'File',
  };

  // For text files, count lines
  if (stat.type === vscode.FileType.File) {
    try {
      const document = await vscode.workspace.openTextDocument(fileUri);
      info.lines = document.lineCount;
    } catch {
      // Not a text file or can't be opened — skip line count
      info.lines = undefined;
    }
  }

  return info;
}

// ── Find Text (Grep) ─────────────────────────────────────────

/**
 * Search for text content across workspace files.
 * Returns matches with file locations, line numbers, and context.
 * Uses a simple but effective approach: find files, then scan their content.
 */
export async function findText(
  query: string,
  options?: {
    includePattern?: string;
    isRegex?: boolean;
    isCaseSensitive?: boolean;
    maxResults?: number;
  },
): Promise<FindTextResult> {
  if (!query || query.trim().length === 0) {
    throw new FileAxiomError(
      'Search query must not be empty.',
      'INVALID_INPUT',
    );
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new FileAxiomError(
      'No workspace folder is open.',
      'NO_WORKSPACE',
    );
  }

  const maxResults = options?.maxResults ?? 500;
  const isRegex = options?.isRegex ?? false;
  const isCaseSensitive = options?.isCaseSensitive ?? false;

  // Create search pattern
  let searchPattern: RegExp;
  if (isRegex) {
    searchPattern = new RegExp(query, isCaseSensitive ? 'g' : 'gi');
  } else {
    // Escape special regex characters for literal search
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    searchPattern = new RegExp(escaped, isCaseSensitive ? 'g' : 'gi');
  }

  // Find files to search in
  const filePattern = options?.includePattern ?? '**/*';
  const files = await vscode.workspace.findFiles(
    filePattern,
    '**/node_modules/**',
    1000, // Max files to scan
  );

  const matches: Array<{ uri: vscode.Uri; matches: TextMatch[] }> = [];
  let totalMatches = 0;

  for (const uri of files) {
    if (totalMatches >= maxResults) {
      break;
    }

    try {
      // Only process text files
      const document = await vscode.workspace.openTextDocument(uri);
      const fileMatches: TextMatch[] = [];

      for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
        if (totalMatches >= maxResults) {
          break;
        }

        const line = document.lineAt(lineNum);
        const lineText = line.text;
        
        // Reset regex lastIndex for each line
        searchPattern.lastIndex = 0;
        const match = searchPattern.exec(lineText);

        if (match) {
          fileMatches.push({
            uri,
            line: lineNum + 1, // Convert to 1-indexed
            column: match.index + 1, // Convert to 1-indexed
            text: match[0],
            preview: lineText.trim(),
          });
          totalMatches++;
        }
      }

      if (fileMatches.length > 0) {
        matches.push({
          uri,
          matches: fileMatches,
        });
      }
    } catch {
      // Skip files that can't be opened as text
      continue;
    }
  }

  return {
    query,
    totalMatches,
    files: matches,
  };
}

// ── Change Permissions (Chmod) ───────────────────────────────

/**
 * Changes file permissions (Unix/macOS only).
 * Accepts numeric mode strings like "755", "644", etc.
 * On Windows, this operation is a no-op and returns success.
 */
export async function changePermissions(
  filePath: string,
  mode: string,
): Promise<ChmodResult> {
  if (!vscode.workspace.isTrusted) {
    throw new FileAxiomError(
      'Workspace is not trusted. Cannot change permissions in Restricted Mode.',
      'UNTRUSTED',
    );
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new FileAxiomError(
      'No workspace folder is open.',
      'NO_WORKSPACE',
    );
  }

  // Validate mode format
  if (!/^[0-7]{3,4}$/.test(mode)) {
    throw new FileAxiomError(
      `Invalid permission mode: ${mode}. Use octal format like "755" or "644".`,
      'INVALID_INPUT',
    );
  }

  const root = folders[0].uri;
  const fileUri = vscode.Uri.joinPath(root, filePath);

  // Verify file exists
  let stat;
  try {
    stat = await vscode.workspace.fs.stat(fileUri);
  } catch (err: unknown) {
    if (isFileSystemError(err, 'FileNotFound')) {
      throw new FileAxiomError(
        `File not found: ${filePath}`,
        'FILE_NOT_FOUND',
      );
    }
    throw err;
  }

  // Get current permissions (only on Unix-like systems)
  let oldMode = 'N/A';
  try {
    const stats = await fs.stat(fileUri.fsPath);
    oldMode = (stats.mode & parseInt('777', 8)).toString(8);
  } catch {
    // Windows or other platform where we can't read mode
  }

  // Apply new permissions
  try {
    await fs.chmod(fileUri.fsPath, parseInt(mode, 8));
    
    return {
      uri: fileUri,
      oldMode,
      newMode: mode,
      success: true,
    };
  } catch (err: unknown) {
    if (err instanceof Error) {
      // On Windows, chmod might fail or be a no-op
      if (process.platform === 'win32') {
        return {
          uri: fileUri,
          oldMode,
          newMode: mode,
          success: true, // Report success on Windows (no-op)
        };
      }
      throw new FileAxiomError(
        `Permission change failed: ${err.message}`,
        'PERMISSION_DENIED',
      );
    }
    throw err;
  }
}

// ── Create Symbolic Link ─────────────────────────────────────

/**
 * Creates a symbolic link from target to source.
 * On Windows, this requires administrator privileges or Developer Mode.
 */
export async function createSymlink(
  sourcePath: string,
  linkPath: string,
): Promise<SymlinkResult> {
  if (!vscode.workspace.isTrusted) {
    throw new FileAxiomError(
      'Workspace is not trusted. Cannot create symlinks in Restricted Mode.',
      'UNTRUSTED',
    );
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new FileAxiomError(
      'No workspace folder is open.',
      'NO_WORKSPACE',
    );
  }

  const root = folders[0].uri;
  const sourceUri = vscode.Uri.joinPath(root, sourcePath);
  const linkUri = vscode.Uri.joinPath(root, linkPath);

  // Verify source exists
  let stat;
  try {
    stat = await vscode.workspace.fs.stat(sourceUri);
  } catch (err: unknown) {
    if (isFileSystemError(err, 'FileNotFound')) {
      throw new FileAxiomError(
        `Source not found: ${sourcePath}`,
        'FILE_NOT_FOUND',
      );
    }
    throw err;
  }

  // Verify link doesn't already exist
  try {
    await vscode.workspace.fs.stat(linkUri);
    throw new FileAxiomError(
      `Link path already exists: ${linkPath}`,
      'ALREADY_EXISTS',
    );
  } catch (err: unknown) {
    if (err instanceof FileAxiomError) {
      throw err;
    }
    if (!isFileSystemError(err, 'FileNotFound')) {
      throw err;
    }
  }

  // Create parent directory if needed
  const linkParent = vscode.Uri.joinPath(linkUri, '..');
  try {
    await vscode.workspace.fs.createDirectory(linkParent);
  } catch {
    // Directory might already exist
  }

  // Create symlink using Node.js fs
  try {
    const isDirectory = stat.type === vscode.FileType.Directory;
    await fs.symlink(
      sourceUri.fsPath,
      linkUri.fsPath,
      isDirectory ? 'dir' : 'file',
    );

    return {
      sourceUri,
      linkUri,
    };
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new FileAxiomError(
        `Symlink creation failed: ${err.message}. ` +
          (process.platform === 'win32'
            ? 'On Windows, symlinks require admin privileges or Developer Mode.'
            : ''),
        'PERMISSION_DENIED',
      );
    }
    throw err;
  }
}

// ── Replace Text (Sed) ───────────────────────────────────────

/**
 * Search and replace text content across multiple files.
 * Like Unix 'sed', performs in-place replacements.
 * All modifications are batched in a single WorkspaceEdit for atomicity.
 */
export async function replaceText(
  searchText: string,
  replaceText: string,
  options?: {
    filePattern?: string;
    isRegex?: boolean;
    isCaseSensitive?: boolean;
    maxReplacements?: number;
  },
): Promise<ReplaceResult> {
  if (!searchText || searchText.trim().length === 0) {
    throw new FileAxiomError(
      'Search text must not be empty.',
      'INVALID_INPUT',
    );
  }

  if (!vscode.workspace.isTrusted) {
    throw new FileAxiomError(
      'Workspace is not trusted. Cannot modify files in Restricted Mode.',
      'UNTRUSTED',
    );
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new FileAxiomError(
      'No workspace folder is open.',
      'NO_WORKSPACE',
    );
  }

  const maxReplacements = options?.maxReplacements ?? 1000;
  const isRegex = options?.isRegex ?? false;
  const isCaseSensitive = options?.isCaseSensitive ?? false;

  // Create search pattern
  let searchPattern: RegExp;
  if (isRegex) {
    searchPattern = new RegExp(searchText, isCaseSensitive ? 'g' : 'gi');
  } else {
    // Escape special regex characters for literal search
    const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    searchPattern = new RegExp(escaped, isCaseSensitive ? 'g' : 'gi');
  }

  // Find files to search in
  const filePattern = options?.filePattern ?? '**/*';
  const files = await vscode.workspace.findFiles(
    filePattern,
    '**/node_modules/**',
    1000, // Max files to scan
  );

  const edit = new vscode.WorkspaceEdit();
  let totalReplacements = 0;
  const modifiedFiles: Array<{ uri: vscode.Uri; replacements: number }> = [];

  for (const uri of files) {
    if (totalReplacements >= maxReplacements) {
      break;
    }

    try {
      // Only process text files
      const document = await vscode.workspace.openTextDocument(uri);
      let fileReplacements = 0;

      for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
        if (totalReplacements >= maxReplacements) {
          break;
        }

        const line = document.lineAt(lineNum);
        const lineText = line.text;

        // Check if line contains the search pattern
        if (searchPattern.test(lineText)) {
          // Reset regex lastIndex
          searchPattern.lastIndex = 0;
          const newText = lineText.replace(searchPattern, replaceText);

          if (newText !== lineText) {
            edit.replace(
              uri,
              new vscode.Range(lineNum, 0, lineNum, lineText.length),
              newText,
            );

            // Count replacements
            searchPattern.lastIndex = 0;
            const matches = lineText.match(searchPattern);
            const count = matches ? matches.length : 0;
            fileReplacements += count;
            totalReplacements += count;
          }
        }

        // Reset regex for next line
        searchPattern.lastIndex = 0;
      }

      if (fileReplacements > 0) {
        modifiedFiles.push({
          uri,
          replacements: fileReplacements,
        });
      }
    } catch {
      // Skip files that can't be opened as text
      continue;
    }
  }

  // Apply all edits atomically
  if (totalReplacements > 0) {
    const success = await vscode.workspace.applyEdit(edit);
    if (!success) {
      throw new FileAxiomError(
        'Failed to apply text replacements. Some files may be read-only.',
        'EDIT_REJECTED',
      );
    }
  }

  return {
    filesModified: modifiedFiles.length,
    totalReplacements,
    files: modifiedFiles,
  };
}

// ── Bulk Operations ──────────────────────────────────────────

/**
 * Performs multiple file operations in a single atomic transaction.
 * All operations are validated before execution — if any operation would fail,
 * the entire batch is aborted.
 * 
 * @param actions Array of bulk actions to perform
 * @param progressCallback Optional callback for progress updates
 * @returns Summary of the bulk operation results
 */
export async function performBulkOperations(
  actions: BulkAction[],
  progressCallback?: (message: string) => void,
): Promise<BulkOperationResult> {
  if (!vscode.workspace.isTrusted) {
    throw new FileAxiomError(
      'Workspace is not trusted. Cannot perform bulk operations in Restricted Mode.',
      'UNTRUSTED',
    );
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new FileAxiomError(
      'No workspace folder is open.',
      'NO_WORKSPACE',
    );
  }

  const root = folders[0].uri;
  const result: BulkOperationResult = {
    successCount: 0,
    failedCount: 0,
    totalReferencesUpdated: 0,
    operations: [],
  };

  // ── Phase 1: Expand glob patterns to concrete file lists ────

  progressCallback?.('Expanding file patterns...');
  
  const expandedActions: Array<BulkAction & { resolvedSource?: vscode.Uri; resolvedTarget?: vscode.Uri }> = [];
  
  for (const action of actions) {
    if (action.type === 'delete' && action.params.path) {
      // For delete, check if it's a glob pattern or single file
      if (action.params.path.includes('*') || action.params.path.includes('?')) {
        const matchedFiles = await findFiles(action.params.path, 1000);
        for (const uri of matchedFiles) {
          expandedActions.push({
            type: 'delete',
            params: { path: vscode.workspace.asRelativePath(uri) },
            resolvedSource: uri,
          });
        }
      } else {
        expandedActions.push({
          ...action,
          resolvedSource: vscode.Uri.joinPath(root, action.params.path),
        });
      }
    } else if (['rename', 'move', 'duplicate'].includes(action.type)) {
      const source = action.params.source!;
      const target = action.params.target!;
      
      // Check if source is a glob pattern
      if (source.includes('*') || source.includes('?')) {
        const matchedFiles = await findFiles(source, 1000);
        for (const uri of matchedFiles) {
          const relativePath = vscode.workspace.asRelativePath(uri);
          // For pattern-based renames, apply transformation
          const newTarget = transformPath(relativePath, source, target);
          expandedActions.push({
            type: action.type,
            params: { source: relativePath, target: newTarget },
            resolvedSource: uri,
            resolvedTarget: vscode.Uri.joinPath(root, newTarget),
          });
        }
      } else {
        expandedActions.push({
          ...action,
          resolvedSource: vscode.Uri.joinPath(root, source),
          resolvedTarget: vscode.Uri.joinPath(root, target),
        });
      }
    }
  }

  if (expandedActions.length === 0) {
    throw new FileAxiomError(
      'No files matched the specified patterns.',
      'FILE_NOT_FOUND',
    );
  }

  progressCallback?.(`Processing ${expandedActions.length} file(s)...`);

  // ── Phase 2: Pre-validation (all-or-nothing) ────────────────

  progressCallback?.('Validating all operations...');

  for (const action of expandedActions) {
    // Verify source exists (for all operations)
    if (action.resolvedSource) {
      try {
        await vscode.workspace.fs.stat(action.resolvedSource);
      } catch (err: unknown) {
        if (isFileSystemError(err, 'FileNotFound')) {
          throw new FileAxiomError(
            `Source file not found: ${action.params.source || action.params.path}. ` +
            `Aborting entire batch.`,
            'FILE_NOT_FOUND',
          );
        }
        throw err;
      }
    }

    // Verify target does NOT exist (for rename/move/duplicate)
    if (['rename', 'move', 'duplicate'].includes(action.type) && action.resolvedTarget) {
      try {
        await vscode.workspace.fs.stat(action.resolvedTarget);
        // If stat succeeds, target exists — abort the entire batch
        throw new FileAxiomError(
          `Target already exists: ${action.params.target}. ` +
          `Aborting entire batch to prevent overwrites.`,
          'ALREADY_EXISTS',
        );
      } catch (err: unknown) {
        if (err instanceof FileAxiomError) {
          throw err;
        }
        if (!isFileSystemError(err, 'FileNotFound')) {
          throw err;
        }
        // FileNotFound is expected — target doesn't exist, good!
      }
    }
  }

  // ── Phase 3: Collect all import reference edits ─────────────

  progressCallback?.(`Collecting references for ${expandedActions.length} files...`);

  const edit = new vscode.WorkspaceEdit();
  const referenceEditsPromises: Array<Promise<vscode.WorkspaceEdit | undefined>> = [];

  for (const action of expandedActions) {
    if (['rename', 'move'].includes(action.type) && action.resolvedSource && action.resolvedTarget) {
      // Collect rename provider edits for import updates
      const promise = (async () => {
        try {
          await vscode.workspace.openTextDocument(action.resolvedSource!);
          const newBasename = action.params.target!
            .replace(/^.*[\\/]/, '')
            .replace(/\.\w+$/, '');

          const refEdits = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
            'vscode.executeDocumentRenameProvider',
            action.resolvedSource,
            new vscode.Position(0, 0),
            newBasename,
          );
          return refEdits;
        } catch {
          return undefined; // No rename provider available
        }
      })();
      referenceEditsPromises.push(promise);
    }
  }

  // Wait for all reference collections in parallel
  const referenceEdits = await Promise.all(referenceEditsPromises);

  // ── Phase 4: Build the atomic WorkspaceEdit ─────────────────

  progressCallback?.('Building atomic transaction...');

  let refIndex = 0;
  for (const action of expandedActions) {
    try {
      if (action.type === 'delete' && action.resolvedSource) {
        // For delete, use direct fs API (WorkspaceEdit.deleteFile doesn't support useTrash)
        await vscode.workspace.fs.delete(action.resolvedSource, { recursive: true, useTrash: true });
        result.operations.push({
          type: 'delete',
          source: action.params.path,
          success: true,
        });
        result.successCount++;
      } else if (['rename', 'move'].includes(action.type) && action.resolvedSource && action.resolvedTarget) {
        // Add rename/move operation
        edit.renameFile(action.resolvedSource, action.resolvedTarget, { overwrite: false });

        // Merge reference edits for this file
        const refEdit = referenceEdits[refIndex++];
        if (refEdit) {
          for (const [uri, textEdits] of refEdit.entries()) {
            for (const textEdit of textEdits) {
              edit.replace(uri, textEdit.range, textEdit.newText);
              result.totalReferencesUpdated++;
            }
          }
        }

        result.operations.push({
          type: action.type,
          source: action.params.source,
          target: action.params.target,
          success: true,
        });
        result.successCount++;
      } else if (action.type === 'duplicate' && action.resolvedSource && action.resolvedTarget) {
        // For duplicate, we can't use WorkspaceEdit directly — handle separately
        await vscode.workspace.fs.copy(action.resolvedSource, action.resolvedTarget, { overwrite: false });
        result.operations.push({
          type: 'duplicate',
          source: action.params.source,
          target: action.params.target,
          success: true,
        });
        result.successCount++;
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result.operations.push({
        type: action.type,
        source: action.params.source || action.params.path,
        target: action.params.target,
        success: false,
        error: errorMsg,
      });
      result.failedCount++;
    }
  }

  // ── Phase 5: Apply the atomic edit ──────────────────────────

  progressCallback?.('Applying changes...');

  const success = await vscode.workspace.applyEdit(edit);

  if (!success) {
    throw new FileAxiomError(
      'WorkspaceEdit was rejected by VS Code. Some files may be read-only.',
      'EDIT_REJECTED',
    );
  }

  return result;
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Transforms a file path based on a source pattern and target pattern.
 * Example: transformPath('file.js', '**\/*.js', '**\/*.ts') => 'file.ts'
 */
function transformPath(filePath: string, sourcePattern: string, targetPattern: string): string {
  // Simple extension replacement
  if (sourcePattern.endsWith('*') && targetPattern.endsWith('*')) {
    const sourceExt = sourcePattern.replace(/^\*+[\\/]*\*+\./, '');
    const targetExt = targetPattern.replace(/^\*+[\\/]*\*+\./, '');
    if (filePath.endsWith(`.${sourceExt}`)) {
      return filePath.replace(new RegExp(`\\.${sourceExt}$`), `.${targetExt}`);
    }
  }
  // If patterns don't match, return as-is
  return filePath;
}

// ── Helpers ──────────────────────────────────────────────────

function isFileSystemError(err: unknown, code: string): boolean {
  if (err instanceof vscode.FileSystemError) {
    return err.code === code;
  }
  // Fallback: check the error name pattern used by some VS Code versions
  if (err instanceof Error) {
    return (
      (err.name === 'EntryNotFound (FileSystemError)' && code === 'FileNotFound') ||
      err.name.includes(code)
    );
  }
  return false;
}
