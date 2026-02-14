import * as vscode from 'vscode';

// ── Error Codes ──────────────────────────────────────────────

export type FileAxiomErrorCode =
  | 'FILE_NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PERMISSION_DENIED'
  | 'UNTRUSTED'
  | 'EDIT_REJECTED'
  | 'NO_WORKSPACE'
  | 'INVALID_INPUT';

export class FileAxiomError extends Error {
  constructor(
    message: string,
    public readonly code: FileAxiomErrorCode,
  ) {
    super(message);
    this.name = 'FileAxiomError';
  }
}

// ── Intent Parser Types ──────────────────────────────────────

export interface FileAxiomIntent {
  operation: 'find' | 'rename' | 'list' | 'duplicate' | 'move' | 'delete' | 'info';
  /** Glob pattern for find operations */
  pattern?: string;
  /** Source file path for rename/duplicate/move operations */
  source?: string;
  /** Target file path for rename/duplicate/move operations */
  target?: string;
  /** Directory path for list operations */
  path?: string;
}

// ── Operation Results ────────────────────────────────────────

export interface RenameResult {
  oldUri: vscode.Uri;
  newUri: vscode.Uri;
  /** Number of import references updated across the workspace */
  referencesUpdated: number;
}

export interface DirectoryEntry {
  name: string;
  type: 'File' | 'Directory';
  uri: vscode.Uri;
}

export interface FileInfo {
  uri: vscode.Uri;
  size: number;
  created: string;
  modified: string;
  type: 'File' | 'Directory';
  lines?: number; // Only for text files
}
