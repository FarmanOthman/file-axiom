import * as vscode from 'vscode';
import { findFiles, renameFile, listDirectory, duplicateFile, moveFile, deleteFile, getFileInfo } from './fileOperations';
import { parseIntent } from './intentParser';
import { FileAxiomError } from './types';

// ── Activation ───────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  console.log('File Axiom activated');

  // ── Chat Participant ─────────────────────────────────────

  const participant = vscode.chat.createChatParticipant(
    'file-axiom.axiom',
    chatHandler,
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');

  // Suggest follow-up actions based on the last result
  participant.followupProvider = {
    provideFollowups(
      result: vscode.ChatResult,
    ): vscode.ProviderResult<vscode.ChatFollowup[]> {
      const meta = result.metadata as Record<string, unknown> | undefined;
      if (meta?.command === 'find') {
        return [
          {
            prompt: 'Rename one of these files',
            label: 'Rename a file',
            command: 'rename',
          },
        ];
      }
      return [];
    },
  };

  context.subscriptions.push(participant);

  // ── Commands ─────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('file-axiom.findFiles', commandFindFiles),
    vscode.commands.registerCommand('file-axiom.renameFile', commandRenameFile),
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}

// ── Chat Handler ─────────────────────────────────────────────

const chatHandler: vscode.ChatRequestHandler = async (
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> => {
  try {
    if (request.command === 'find') {
      return await handleFind(request.prompt, stream);
    }
    if (request.command === 'rename') {
      return await handleRename(request.prompt, stream);
    }
    if (request.command === 'list') {
      return await handleList(request.prompt, stream);
    }
    if (request.command === 'duplicate') {
      return await handleDuplicate(request.prompt, stream);
    }
    if (request.command === 'move') {
      return await handleMove(request.prompt, stream);
    }
    if (request.command === 'delete') {
      return await handleDelete(request.prompt, stream);
    }
    if (request.command === 'info') {
      return await handleInfo(request.prompt, stream);
    }

    // No slash command — use LLM intent extraction
    stream.progress('Analyzing your request…');
    const intent = await parseIntent(request.prompt, request.model, token);

    if (intent.operation === 'find' && intent.pattern) {
      return await handleFind(intent.pattern, stream);
    }
    if (intent.operation === 'rename' && intent.source && intent.target) {
      return await handleRename(
        `${intent.source} to ${intent.target}`,
        stream,
      );
    }
    if (intent.operation === 'list' && intent.path) {
      return await handleList(intent.path, stream);
    }
    if (intent.operation === 'duplicate' && intent.source && intent.target) {
      return await handleDuplicate(
        `${intent.source} to ${intent.target}`,
        stream,
      );
    }
    if (intent.operation === 'move' && intent.source && intent.target) {
      return await handleMove(
        `${intent.source} to ${intent.target}`,
        stream,
      );
    }
    if (intent.operation === 'delete' && intent.path) {
      return await handleDelete(intent.path, stream);
    }
    if (intent.operation === 'info' && intent.path) {
      return await handleInfo(intent.path, stream);
    }

    stream.markdown(usageHelp());
    return { metadata: { command: 'help' } };
  } catch (err) {
    return handleError(err, stream);
  }
};

// ── /find Handler ────────────────────────────────────────────

async function handleFind(
  pattern: string,
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult> {
  stream.progress('Searching files…');

  const uris = await findFiles(pattern.trim());

  if (uris.length === 0) {
    stream.markdown(`No files matched the pattern \`${pattern}\`.`);
    return { metadata: { command: 'find' } };
  }

  stream.markdown(
    `**Found ${uris.length} file(s)** matching \`${pattern}\`:\n\n`,
  );

  for (const uri of uris) {
    const relPath = vscode.workspace.asRelativePath(uri);
    stream.anchor(uri, relPath);
    stream.markdown('\n');
  }

  return { metadata: { command: 'find' } };
}

// ── /rename Handler ──────────────────────────────────────────

async function handleRename(
  prompt: string,
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult> {
  const parts = prompt.split(/\s+to\s+/i);

  if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) {
    stream.markdown(
      '**Usage:** `/rename oldFile.ts to newFile.ts`\n\n' +
        'Separate the source and target filenames with `to`.',
    );
    return { metadata: { command: 'rename' } };
  }

  const source = parts[0].trim();
  const target = parts[1].trim();

  stream.progress(`Renaming ${source} → ${target}…`);

  const result = await renameFile(source, target);

  const refs =
    result.referencesUpdated > 0
      ? ` Updated **${result.referencesUpdated}** import reference(s).`
      : '';

  stream.markdown(`**Renamed** \`${source}\` → \`${target}\`.${refs}\n\n`);
  stream.anchor(result.newUri, vscode.workspace.asRelativePath(result.newUri));

  return { metadata: { command: 'rename' } };
}

// ── /list Handler ────────────────────────────────────────────

async function handleList(
  dirPath: string,
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult> {
  stream.progress(`Listing directory: ${dirPath}…`);

  const entries = await listDirectory(dirPath.trim());

  if (entries.length === 0) {
    stream.markdown(`Directory \`${dirPath}\` is empty.`);
    return { metadata: { command: 'list' } };
  }

  stream.markdown(
    `**Directory \`${dirPath}\`** (${entries.length} item(s)):\n\n`,
  );

  for (const entry of entries) {
    const icon = entry.type === 'Directory' ? '📁' : '📄';
    stream.markdown(`${icon} `);
    stream.anchor(entry.uri, entry.name);
    stream.markdown('\n');
  }

  return { metadata: { command: 'list' } };
}

// ── /duplicate Handler ───────────────────────────────────────

async function handleDuplicate(
  prompt: string,
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult> {
  const parts = prompt.split(/\s+to\s+/i);

  if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) {
    stream.markdown(
      '**Usage:** `/duplicate source.ts to copy.ts`\n\n' +
        'Separate the source and target filenames with `to`.',
    );
    return { metadata: { command: 'duplicate' } };
  }

  const source = parts[0].trim();
  const target = parts[1].trim();

  stream.progress(`Duplicating ${source} → ${target}…`);

  const result = await duplicateFile(source, target);

  stream.markdown(`**Duplicated** \`${source}\` → \`${target}\`\n\n`);
  stream.anchor(result.targetUri, vscode.workspace.asRelativePath(result.targetUri));

  return { metadata: { command: 'duplicate' } };
}

// ── /move Handler ────────────────────────────────────────────

async function handleMove(
  prompt: string,
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult> {
  const parts = prompt.split(/\s+to\s+/i);

  if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) {
    stream.markdown(
      '**Usage:** `/move file.ts to folder/file.ts`\n\n' +
        'Separate the source and target paths with `to`.',
    );
    return { metadata: { command: 'move' } };
  }

  const source = parts[0].trim();
  const target = parts[1].trim();

  stream.progress(`Moving ${source} → ${target}…`);

  const result = await moveFile(source, target);

  const refs =
    result.referencesUpdated > 0
      ? ` Updated **${result.referencesUpdated}** import reference(s).`
      : '';

  stream.markdown(`**Moved** \`${source}\` → \`${target}\`.${refs}\n\n`);
  stream.anchor(result.newUri, vscode.workspace.asRelativePath(result.newUri));

  return { metadata: { command: 'move' } };
}

// ── /delete Handler ──────────────────────────────────────────

async function handleDelete(
  filePath: string,
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult> {
  stream.progress(`Deleting ${filePath}…`);

  const result = await deleteFile(filePath.trim());

  stream.markdown(
    `**Deleted** \`${filePath}\` (moved to trash)\n\n` +
      'The file can be recovered from your system trash.',
  );

  return { metadata: { command: 'delete' } };
}

// ── /info Handler ────────────────────────────────────────────

async function handleInfo(
  filePath: string,
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult> {
  stream.progress(`Getting info for ${filePath}…`);

  const info = await getFileInfo(filePath.trim());

  stream.markdown(`**File Info:** \`${filePath}\`\n\n`);
  stream.markdown(`- **Type:** ${info.type}\n`);
  stream.markdown(`- **Size:** ${formatBytes(info.size)}\n`);
  if (info.lines !== undefined) {
    stream.markdown(`- **Lines:** ${info.lines}\n`);
  }
  stream.markdown(`- **Created:** ${info.created}\n`);
  stream.markdown(`- **Modified:** ${info.modified}\n\n`);
  stream.anchor(info.uri, 'Open file');

  return { metadata: { command: 'info' } };
}

// ── Command Palette: Find Files ──────────────────────────────

async function commandFindFiles(): Promise<void> {
  const pattern = await vscode.window.showInputBox({
    title: 'File Axiom: Find Files',
    prompt: 'Enter a glob pattern (e.g., **/*.ts)',
    placeHolder: '**/*.ts',
  });

  if (!pattern) {
    return;
  }

  try {
    const uris = await findFiles(pattern);

    if (uris.length === 0) {
      vscode.window.showInformationMessage(`No files matched: ${pattern}`);
      return;
    }

    const picked = await vscode.window.showQuickPick(
      uris.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        uri,
      })),
      {
        title: `Found ${uris.length} file(s)`,
        placeHolder: 'Select a file to open',
      },
    );

    if (picked) {
      await vscode.window.showTextDocument(picked.uri);
    }
  } catch (err) {
    showError(err);
  }
}

// ── Command Palette: Rename File ─────────────────────────────

async function commandRenameFile(): Promise<void> {
  const source = await vscode.window.showInputBox({
    title: 'File Axiom: Rename File (1/2)',
    prompt: 'Current file path (relative to workspace root)',
    placeHolder: 'src/UserSvc.ts',
  });

  if (!source) {
    return;
  }

  const target = await vscode.window.showInputBox({
    title: 'File Axiom: Rename File (2/2)',
    prompt: 'New file path (relative to workspace root)',
    placeHolder: 'src/MemberService.ts',
  });

  if (!target) {
    return;
  }

  try {
    const result = await renameFile(source, target);

    const refs =
      result.referencesUpdated > 0
        ? ` (${result.referencesUpdated} import references updated)`
        : '';

    vscode.window.showInformationMessage(
      `Renamed ${source} → ${target}${refs}`,
    );
  } catch (err) {
    showError(err);
  }
}

// ── Error Handling ───────────────────────────────────────────

function handleError(
  err: unknown,
  stream: vscode.ChatResponseStream,
): vscode.ChatResult {
  if (err instanceof FileAxiomError) {
    stream.markdown(`**Error [${err.code}]:** ${err.message}`);
    return { errorDetails: { message: err.message } };
  }

  const message = err instanceof Error ? err.message : String(err);
  stream.markdown(`**Unexpected error:** ${message}`);
  console.error('[File Axiom]', err);
  return { errorDetails: { message } };
}

function showError(err: unknown): void {
  const message =
    err instanceof FileAxiomError
      ? `[${err.code}] ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  vscode.window.showErrorMessage(`File Axiom: ${message}`);
}

// ── Help Text ────────────────────────────────────────────────

function usageHelp(): string {
  return [
    '### File Axiom — Usage',
    '',
    '| Command | Example |',
    '|---------|---------|',
    '| `/find` | `@axiom /find **/*.ts` |',
    '| `/rename` | `@axiom /rename old.ts to new.ts` |',
    '| `/list` | `@axiom /list src` |',
    '| `/duplicate` | `@axiom /duplicate file.ts to copy.ts` |',
    '| `/move` | `@axiom /move file.ts to folder/file.ts` |',
    '| `/delete` | `@axiom /delete old-file.ts` |',
    '| `/info` | `@axiom /info package.json` |',
    '| *Natural language* | `@axiom show me files in src folder` |',
    '',
    'All rename/move operations are atomic — imports updated silently.',
  ].join('\n');
}

// ── Helpers ──────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) { return '0 Bytes'; }
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}
