import * as vscode from 'vscode';
import { FileAxiomError, FileAxiomIntent } from './types';

/**
 * Uses the Language Model API to extract a structured intent from a
 * free-form natural language prompt. Falls back to a regex parser if
 * the LLM is unavailable or returns malformed output.
 */
export async function parseIntent(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<FileAxiomIntent> {
  const systemPrompt = `You are a strict intent-extraction engine for file operations.
Given a user request, output ONLY a JSON object — no markdown, no explanation.

Schema:
{
  "operation": "find" | "rename" | "list" | "duplicate" | "move" | "delete" | "info",
  "pattern": "<glob pattern, only for find>",
  "source": "<current filename, for rename/duplicate/move>",
  "target": "<new filename, for rename/duplicate/move>",
  "path": "<file or directory path, for list/delete/info>"
}

Rules:
- find: search/find/locate files by pattern
- rename: rename a file (same directory)
- list: show directory contents / list files in folder
- duplicate: copy a file to new location
- move: move file to different directory
- delete: remove/delete a file (safely to trash)
- info: get metadata (size, dates, lines) for a file
- Paths should be relative to the workspace root.
- Output ONLY the JSON object. No other text.`;

  const fewShot: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User('find all TypeScript files'),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"find","pattern":"**/*.ts"}',
    ),
    vscode.LanguageModelChatMessage.User(
      'rename UserSvc.ts to MemberService.ts',
    ),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"rename","source":"UserSvc.ts","target":"MemberService.ts"}',
    ),
    vscode.LanguageModelChatMessage.User('show me what files are in src folder'),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"list","path":"src"}',
    ),
    vscode.LanguageModelChatMessage.User('duplicate config.json to config.backup.json'),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"duplicate","source":"config.json","target":"config.backup.json"}',
    ),
    vscode.LanguageModelChatMessage.User('move utils.ts to src/helpers/utils.ts'),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"move","source":"utils.ts","target":"src/helpers/utils.ts"}',
    ),
    vscode.LanguageModelChatMessage.User('delete old-test.js'),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"delete","path":"old-test.js"}',
    ),
    vscode.LanguageModelChatMessage.User('get info about package.json'),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"info","path":"package.json"}',
    ),
  ];

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(systemPrompt),
    ...fewShot,
    vscode.LanguageModelChatMessage.User(prompt),
  ];

  try {
    const response = await model.sendRequest(
      messages,
      { justification: 'Parsing file operation intent for @axiom' },
      token,
    );

    // Collect the full streamed response
    let fullText = '';
    for await (const chunk of response.text) {
      fullText += chunk;
    }

    // Strip markdown code fences if the model wraps the JSON
    fullText = fullText
      .replace(/```(?:json)?\s*/g, '')
      .replace(/```/g, '')
      .trim();

    const parsed = JSON.parse(fullText) as FileAxiomIntent;

    // Validate required fields
    const validOps = ['find', 'rename', 'list', 'duplicate', 'move', 'delete', 'info'];
    if (!parsed.operation || !validOps.includes(parsed.operation)) {
      throw new Error('Invalid operation');
    }
    if (parsed.operation === 'find' && !parsed.pattern) {
      throw new Error('Missing pattern for find operation');
    }
    if (['rename', 'duplicate', 'move'].includes(parsed.operation) && (!parsed.source || !parsed.target)) {
      throw new Error('Missing source or target');
    }
    if (['list', 'delete', 'info'].includes(parsed.operation) && !parsed.path) {
      throw new Error('Missing path');
    }

    return parsed;
  } catch {
    // If LLM fails, attempt a basic regex fallback
    return regexFallback(prompt);
  }
}

// ── Regex Fallback ────────────────────────────────────────────

function regexFallback(prompt: string): FileAxiomIntent {
  const lower = prompt.toLowerCase().trim();

  // Detect list: "list X", "show X", "ls X", "what's in X"
  const listMatch = prompt.match(
    /(?:list|show|ls|what'?s?\s+in)\s+(?:files?\s+in\s+)?(.+)/i,
  );
  if (listMatch) {
    return { operation: 'list', path: listMatch[1].trim() };
  }

  // Detect duplicate: "duplicate X to Y", "copy X to Y"
  const duplicateMatch = prompt.match(
    /(?:duplicate|copy)\s+(\S+)\s+to\s+(\S+)/i,
  );
  if (duplicateMatch) {
    return {
      operation: 'duplicate',
      source: duplicateMatch[1],
      target: duplicateMatch[2],
    };
  }

  // Detect move: "move X to Y"
  const moveMatch = prompt.match(/move\s+(\S+)\s+to\s+(\S+)/i);
  if (moveMatch) {
    return {
      operation: 'move',
      source: moveMatch[1],
      target: moveMatch[2],
    };
  }

  // Detect rename: "rename X to Y", "change X to Y"
  const renameMatch = prompt.match(
    /(?:rename|change)\s+(\S+)\s+to\s+(\S+)/i,
  );
  if (renameMatch) {
    return {
      operation: 'rename',
      source: renameMatch[1],
      target: renameMatch[2],
    };
  }

  // Detect delete: "delete X", "remove X", "trash X"
  const deleteMatch = prompt.match(/(?:delete|remove|trash)\s+(.+)/i);
  if (deleteMatch) {
    return { operation: 'delete', path: deleteMatch[1].trim() };
  }

  // Detect info: "info about X", "get info on X", "metadata for X"
  const infoMatch = prompt.match(
    /(?:info|metadata|details?)(?:\s+(?:about|on|for))?\s+(.+)/i,
  );
  if (infoMatch) {
    return { operation: 'info', path: infoMatch[1].trim() };
  }

  // Detect find: "find X", "search for X", "locate X"
  const findMatch = prompt.match(
    /(?:find|search|locate|look\s+for)\s+(.+)/i,
  );
  if (findMatch) {
    let pattern = findMatch[1].trim();
    // If it doesn't look like a glob, wrap it
    if (!pattern.includes('*') && !pattern.includes('?')) {
      pattern = `**/*${pattern}*`;
    }
    return { operation: 'find', pattern };
  }

  throw new FileAxiomError(
    `Could not understand the request: "${prompt}". ` +
      'Try "@axiom /find *.ts" or "@axiom /rename old.ts to new.ts".',
    'INVALID_INPUT',
  );
}
