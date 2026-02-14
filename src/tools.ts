import * as vscode from 'vscode';
import { performBulkOperations, findFiles, replaceText } from './fileOperations';
import { BulkAction } from './types';

// ── Bulk Rename Tool ─────────────────────────────────────────

interface BulkRenameParams {
  operations: Array<{ source: string; target: string }>;
}

export class BulkRenameTool implements vscode.LanguageModelTool<BulkRenameParams> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<BulkRenameParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    console.log('[FILE AXIOM - BulkRenameTool] invoke() called with:', options.input);
    try {
      const { operations } = options.input;

      // Convert to BulkAction format
      const actions: BulkAction[] = operations.map(op => ({
        type: 'rename',
        params: {
          source: op.source,
          target: op.target,
        },
      }));

      // Perform bulk rename with progress callback
      const result = await performBulkOperations(
        actions,
        (message: string) => {
          options.tokenizationOptions?.tokenBudget;
          // Progress feedback (optional)
        },
      );

      // Return machine-readable JSON result
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            status: 'success',
            appliedEdits: result.successCount,
            failedEdits: result.failedCount,
            totalReferencesUpdated: result.totalReferencesUpdated,
            summary: `Renamed ${result.successCount} file(s) with ${result.totalReferencesUpdated} reference update(s)`,
            operations: result.operations,
          }),
        ),
      ]);
    } catch (err: unknown) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            status: 'error',
            message: err instanceof Error ? err.message : 'Unknown error',
          }),
        ),
      ]);
    }
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<BulkRenameParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    console.log('[FILE AXIOM - BulkRenameTool] prepareInvocation() called with:', options.input);
    const { operations } = options.input;
    const count = operations.length;

    return {
      invocationMessage: `File Axiom will rename ${count} file(s) with atomic import updates`,
      confirmationMessages: {
        title: 'File Axiom: Bulk Rename',
        message: new vscode.MarkdownString(
          `**Rename ${count} file(s)?**\n\n` +
            operations
              .slice(0, 10)
              .map(op => `- \`${op.source}\` → \`${op.target}\``)
              .join('\n') +
            (count > 10 ? `\n\n_... and ${count - 10} more_` : ''),
        ),
      },
    };
  }
}

// ── Bulk Search Tool ─────────────────────────────────────────

interface BulkSearchParams {
  patterns: string[];
  maxResults?: number;
}

export class BulkSearchTool implements vscode.LanguageModelTool<BulkSearchParams> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<BulkSearchParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    console.log('[FILE AXIOM - BulkSearchTool] invoke() called with:', options.input);
    try {
      const { patterns, maxResults = 100 } = options.input;

      const allResults: Record<string, string[]> = {};

      for (const pattern of patterns) {
        const uris = await findFiles(pattern, maxResults);
        allResults[pattern] = uris.map(uri =>
          vscode.workspace.asRelativePath(uri),
        );
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            status: 'success',
            totalFiles: Object.values(allResults).flat().length,
            results: allResults,
          }),
        ),
      ]);
    } catch (err: unknown) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            status: 'error',
            message: err instanceof Error ? err.message : 'Unknown error',
          }),
        ),
      ]);
    }
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<BulkSearchParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    console.log('[FILE AXIOM - BulkSearchTool] prepareInvocation() called with:', options.input);
    const { patterns } = options.input;

    return {
      invocationMessage: `File Axiom will search for ${patterns.length} pattern(s)`,
    };
  }
}

// ── Bulk Replace Tool ────────────────────────────────────────

interface BulkReplaceParams {
  searchText: string;
  replaceText: string;
  filePattern?: string;
  isRegex?: boolean;
  isCaseSensitive?: boolean;
  maxReplacements?: number;
}

export class BulkReplaceTool implements vscode.LanguageModelTool<BulkReplaceParams> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<BulkReplaceParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    console.log('[FILE AXIOM - BulkReplaceTool] invoke() called with:', options.input);
    try {
      const {
        searchText,
        replaceText: replacementText,
        filePattern = '**/*',
        isRegex = false,
        isCaseSensitive = false,
        maxReplacements = 1000,
      } = options.input;

      const result = await replaceText(searchText, replacementText, {
        filePattern,
        isRegex,
        isCaseSensitive,
        maxReplacements,
      });

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            status: 'success',
            filesModified: result.filesModified,
            totalReplacements: result.totalReplacements,
            summary: `Replaced ${result.totalReplacements} occurrence(s) in ${result.filesModified} file(s)`,
            files: result.files.map(f => ({
              path: vscode.workspace.asRelativePath(f.uri),
              replacements: f.replacements,
            })),
          }),
        ),
      ]);
    } catch (err: unknown) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            status: 'error',
            message: err instanceof Error ? err.message : 'Unknown error',
          }),
        ),
      ]);
    }
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<BulkReplaceParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const { searchText, replaceText, filePattern = '**/*' } = options.input;

    return {
      invocationMessage: `File Axiom will replace "${searchText}" with "${replaceText}" in ${filePattern}`,
      confirmationMessages: {
        title: 'File Axiom: Bulk Replace',
        message: new vscode.MarkdownString(
          `**Replace text across files?**\n\n` +
            `- **Search:** \`${searchText}\`\n` +
            `- **Replace:** \`${replaceText}\`\n` +
            `- **Files:** \`${filePattern}\``,
        ),
      },
    };
  }
}

// ── Bulk Delete Tool ─────────────────────────────────────────

interface BulkDeleteParams {
  paths: string[];
}

export class BulkDeleteTool implements vscode.LanguageModelTool<BulkDeleteParams> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<BulkDeleteParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    console.log('[FILE AXIOM - BulkDeleteTool] invoke() called with:', options.input);
    try {
      const { paths } = options.input;

      // Convert paths to delete actions
      const actions: BulkAction[] = paths.map(path => ({
        type: 'delete',
        params: { path },
      }));

      const result = await performBulkOperations(actions);

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            status: 'success',
            deletedCount: result.successCount,
            failedCount: result.failedCount,
            summary: `Deleted ${result.successCount} file(s) (moved to trash)`,
            operations: result.operations,
          }),
        ),
      ]);
    } catch (err: unknown) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            status: 'error',
            message: err instanceof Error ? err.message : 'Unknown error',
          }),
        ),
      ]);
    }
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<BulkDeleteParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const { paths } = options.input;

    return {
      invocationMessage: `File Axiom will delete ${paths.length} file(s) (recoverable from trash)`,
      confirmationMessages: {
        title: 'File Axiom: Bulk Delete',
        message: new vscode.MarkdownString(
          `**Delete ${paths.length} file(s)?**\n\n` +
            `Files will be moved to system trash (recoverable).\n\n` +
            paths
              .slice(0, 10)
              .map(p => `- \`${p}\``)
              .join('\n') +
            (paths.length > 10 ? `\n\n_... and ${paths.length - 10} more_` : ''),
        ),
      },
    };
  }
}

// ── Bulk Move Tool ───────────────────────────────────────────

interface BulkMoveParams {
  operations: Array<{ source: string; target: string }>;
}

export class BulkMoveTool implements vscode.LanguageModelTool<BulkMoveParams> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<BulkMoveParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    console.log('[FILE AXIOM - BulkMoveTool] invoke() called with:', options.input);
    try {
      const { operations } = options.input;

      // Convert to BulkAction format
      const actions: BulkAction[] = operations.map(op => ({
        type: 'move',
        params: {
          source: op.source,
          target: op.target,
        },
      }));

      const result = await performBulkOperations(actions);

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            status: 'success',
            appliedEdits: result.successCount,
            failedEdits: result.failedCount,
            totalReferencesUpdated: result.totalReferencesUpdated,
            summary: `Moved ${result.successCount} file(s) with ${result.totalReferencesUpdated} reference update(s)`,
            operations: result.operations,
          }),
        ),
      ]);
    } catch (err: unknown) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({
            status: 'error',
            message: err instanceof Error ? err.message : 'Unknown error',
          }),
        ),
      ]);
    }
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<BulkMoveParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const { operations } = options.input;
    const count = operations.length;

    return {
      invocationMessage: `File Axiom will move ${count} file(s) with atomic import updates`,
      confirmationMessages: {
        title: 'File Axiom: Bulk Move',
        message: new vscode.MarkdownString(
          `**Move ${count} file(s)?**\n\n` +
            operations
              .slice(0, 10)
              .map(op => `- \`${op.source}\` → \`${op.target}\``)
              .join('\n') +
            (count > 10 ? `\n\n_... and ${count - 10} more_` : ''),
        ),
      },
    };
  }
}
