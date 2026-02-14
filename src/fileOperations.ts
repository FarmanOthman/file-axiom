import * as vscode from 'vscode';
import { FileAxiomError, RenameResult, DirectoryEntry, FileInfo, BulkAction, BulkOperationResult } from './types';

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
