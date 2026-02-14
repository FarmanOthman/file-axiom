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
  operation: 'find' | 'rename';
  /** Glob pattern for find operations */
  pattern?: string;
  /** Source file path for rename operations */
  source?: string;
  /** Target file path for rename operations */
  target?: string;
}

// ── Rename Result ────────────────────────────────────────────

export interface RenameResult {
  oldUri: vscode.Uri;
  newUri: vscode.Uri;
  /** Number of import references updated across the workspace */
  referencesUpdated: number;
}
