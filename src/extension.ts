import * as vscode from 'vscode';
import { findFiles, renameFile } from './fileOperations';
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
    '| `/rename` | `@axiom /rename UserSvc.ts to MemberService.ts` |',
    '| *Natural language* | `@axiom rename Auth.js to Security.js` |',
    '',
    'All renames are atomic — imports are updated silently via the Language Server.',
  ].join('\n');
}
