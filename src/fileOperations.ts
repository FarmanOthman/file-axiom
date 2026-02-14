import * as vscode from 'vscode';
import { FileAxiomError, RenameResult } from './types';

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
