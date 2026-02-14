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
  operation: 'find' | 'rename' | 'list' | 'duplicate' | 'move' | 'delete' | 'info' | 'findText' | 'chmod' | 'symlink' | 'replace';
  /** Glob pattern for find operations */
  pattern?: string;
  /** Search query for findText operations */
  query?: string;
  /** File pattern to search within (for findText) */
  includePattern?: string;
  /** Source file path for rename/duplicate/move/symlink operations */
  source?: string;
  /** Target file path for rename/duplicate/move/symlink operations */
  target?: string;
  /** Directory path for list operations */
  path?: string;
  /** Permissions mode for chmod operations (e.g., "755", "644") */
  mode?: string;
  /** Search text for replace operations */
  searchText?: string;
  /** Replacement text for replace operations */
  replaceText?: string;
  /** File pattern for replace operations */
  filePattern?: string;
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

export interface TextMatch {
  uri: vscode.Uri;
  line: number;
  column: number;
  text: string;
  preview: string;
}

export interface FindTextResult {
  query: string;
  totalMatches: number;
  files: Array<{
    uri: vscode.Uri;
    matches: TextMatch[];
  }>;
}

export interface ChmodResult {
  uri: vscode.Uri;
  oldMode: string;
  newMode: string;
  success: boolean;
}

export interface SymlinkResult {
  sourceUri: vscode.Uri;
  linkUri: vscode.Uri;
}

export interface ReplaceResult {
  filesModified: number;
  totalReplacements: number;
  files: Array<{
    uri: vscode.Uri;
    replacements: number;
  }>;
}

// ── Bulk Operations ──────────────────────────────────────────

export type BulkActionType = 'rename' | 'delete' | 'duplicate' | 'move';

export interface BulkAction {
  type: BulkActionType;
  params: {
    source?: string;
    target?: string;
    path?: string;
  };
}

export interface BulkIntent {
  actions: BulkAction[];
  dryRun?: boolean;
}

export interface BulkOperationResult {
  successCount: number;
  failedCount: number;
  totalReferencesUpdated: number;
  operations: Array<{
    type: BulkActionType;
    source?: string;
    target?: string;
    success: boolean;
    error?: string;
  }>;
}
