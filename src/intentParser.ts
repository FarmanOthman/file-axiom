import * as vscode from 'vscode';
import { FileAxiomError, FileAxiomIntent, BulkIntent } from './types';

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
  "operation": "find" | "rename" | "list" | "duplicate" | "move" | "delete" | "info" | "findText" | "chmod" | "symlink" | "replace",
  "pattern": "<glob pattern, only for find>",
  "query": "<search text, only for findText>",
  "includePattern": "<file pattern to search within, optional for findText>",
  "source": "<current filename, for rename/duplicate/move/symlink>",
  "target": "<new filename, for rename/duplicate/move/symlink>",
  "path": "<file or directory path, for list/delete/info/chmod>",
  "mode": "<permission mode like 755 or 644, only for chmod>",
  "searchText": "<text to search for, only for replace>",
  "replaceText": "<replacement text, only for replace>",
  "filePattern": "<file pattern for replace operations>"
}

Rules:
- find: search/find/locate files by pattern
- findText: search for text content within files (grep)
- rename: rename a file (same directory)
- list: show directory contents / list files in folder
- duplicate: copy a file to new location
- move: move file to different directory
- delete: remove/delete a file (safely to trash)
- info: get metadata (size, dates, lines) for a file
- chmod: change file permissions (Unix/macOS)
- symlink: create symbolic link
- replace: search and replace text in files (sed)
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
    vscode.LanguageModelChatMessage.User('search for "TODO" in all files'),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"findText","query":"TODO"}',
    ),
    vscode.LanguageModelChatMessage.User('grep "import React" in src folder'),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"findText","query":"import React","includePattern":"src/**"}',
    ),
    vscode.LanguageModelChatMessage.User('change permissions of deploy.sh to 755'),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"chmod","path":"deploy.sh","mode":"755"}',
    ),
    vscode.LanguageModelChatMessage.User('create symlink from config.json to config.link'),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"symlink","source":"config.json","target":"config.link"}',
    ),
    vscode.LanguageModelChatMessage.User('replace "foo" with "bar" in all .ts files'),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"replace","searchText":"foo","replaceText":"bar","filePattern":"**/*.ts"}',
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
    const validOps = ['find', 'rename', 'list', 'duplicate', 'move', 'delete', 'info', 'findText', 'chmod', 'symlink', 'replace'];
    if (!parsed.operation || !validOps.includes(parsed.operation)) {
      throw new Error('Invalid operation');
    }
    if (parsed.operation === 'find' && !parsed.pattern) {
      throw new Error('Missing pattern for find operation');
    }
    if (parsed.operation === 'findText' && !parsed.query) {
      throw new Error('Missing query for findText operation');
    }
    if (['rename', 'duplicate', 'move', 'symlink'].includes(parsed.operation) && (!parsed.source || !parsed.target)) {
      throw new Error('Missing source or target');
    }
    if (['list', 'delete', 'info'].includes(parsed.operation) && !parsed.path) {
      throw new Error('Missing path');
    }
    if (parsed.operation === 'chmod' && (!parsed.path || !parsed.mode)) {
      throw new Error('Missing path or mode for chmod operation');
    }
    if (parsed.operation === 'replace' && (!parsed.searchText || !parsed.replaceText)) {
      throw new Error('Missing searchText or replaceText for replace operation');
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

  // Detect findText: "grep X", "search for text X", "find text X"
  const findTextMatch = prompt.match(
    /(?:grep|search\s+(?:for\s+)?text|find\s+text)\s+["']?([^"']+)["']?(?:\s+in\s+(.+))?/i,
  );
  if (findTextMatch) {
    const query = findTextMatch[1].trim();
    const includePattern = findTextMatch[2]?.trim();
    return { operation: 'findText', query, includePattern };
  }

  // Detect chmod: "chmod X to Y", "change permissions of X to Y", "set X to Y"
  const chmodMatch = prompt.match(
    /(?:chmod|change\s+permissions?\s+of|set\s+permissions?\s+of|make)\s+(.+?)\s+(?:to\s+)?(\d{3,4})/i,
  );
  if (chmodMatch) {
    return {
      operation: 'chmod',
      path: chmodMatch[1].trim(),
      mode: chmodMatch[2].trim(),
    };
  }

  // Detect symlink: "symlink X to Y", "link X to Y", "create link from X to Y"
  const symlinkMatch = prompt.match(
    /(?:symlink|link|create\s+(?:symlink|link)(?:\s+from)?)\s+(.+?)\s+(?:to|as)\s+(.+)/i,
  );
  if (symlinkMatch) {
    return {
      operation: 'symlink',
      source: symlinkMatch[1].trim(),
      target: symlinkMatch[2].trim(),
    };
  }

  // Detect replace: "replace X with Y", "replace X with Y in Z"
  const replaceMatch = prompt.match(
    /replace\s+["']?([^"']+)["']?\s+with\s+["']?([^"']+)["']?(?:\s+in\s+(.+))?/i,
  );
  if (replaceMatch) {
    return {
      operation: 'replace',
      searchText: replaceMatch[1].trim(),
      replaceText: replaceMatch[2].trim(),
      filePattern: replaceMatch[3]?.trim() || '**/*',
    };
  }

  throw new FileAxiomError(
    `Could not understand the request: "${prompt}". ` +
      'Try "@axiom /find *.ts" or "@axiom /rename old.ts to new.ts".',
    'INVALID_INPUT',
  );
}

// ── Bulk Intent Parser ───────────────────────────────────────

/**
 * Parses natural language requests that involve MULTIPLE file operations.
 * Examples: "rename all .js files to .ts", "delete all test files"
 * Returns a BulkIntent with an array of actions.
 */
export async function parseBulkIntent(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<BulkIntent> {
  const systemPrompt = `You are a bulk file operation intent extractor.
Given a user request that involves MULTIPLE files, output a JSON object with an array of actions.

Schema:
{
  "actions": [
    {
      "type": "rename" | "delete" | "duplicate" | "move",
      "params": {
        "source": "<source file path>",
        "target": "<target file path (for rename/duplicate/move)>",
        "path": "<file path (for delete)>"
      }
    }
  ]
}

Rules:
- For plural requests like "rename all X", expand into multiple actions
- For pattern-based requests, use glob patterns to describe the files
- type: "rename" (same dir), "move" (different dir), "duplicate" (copy), "delete" (trash)
- Output ONLY the JSON object. No markdown, no explanation.

Examples:
User: "rename all .js files to .ts"
Assistant: {"actions":[{"type":"rename","params":{"source":"**/*.js","target":"**/*.ts"}}]}

User: "delete old-test.js and deprecated.js"
Assistant: {"actions":[{"type":"delete","params":{"path":"old-test.js"}},{"type":"delete","params":{"path":"deprecated.js"}}]}

User: "move all utils to src/helpers"
Assistant: {"actions":[{"type":"move","params":{"source":"**/*utils*","target":"src/helpers/"}}]}`;

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(systemPrompt),
    vscode.LanguageModelChatMessage.User(prompt),
  ];

  try {
    const response = await model.sendRequest(
      messages,
      { justification: 'Parsing bulk file operation intent for @axiom' },
      token,
    );

    // Collect the full streamed response
    let fullText = '';
    for await (const chunk of response.text) {
      fullText += chunk;
    }

    // Strip markdown code fences
    fullText = fullText
      .replace(/```(?:json)?\s*/g, '')
      .replace(/```/g, '')
      .trim();

    const parsed = JSON.parse(fullText) as BulkIntent;

    // Validate structure
    if (!parsed.actions || !Array.isArray(parsed.actions)) {
      throw new Error('Invalid bulk intent: missing actions array');
    }

    // Validate each action
    for (const action of parsed.actions) {
      if (!action.type || !['rename', 'delete', 'duplicate', 'move'].includes(action.type)) {
        throw new Error(`Invalid action type: ${action.type}`);
      }
      if (!action.params) {
        throw new Error('Invalid action: missing params');
      }
    }

    return parsed;
  } catch (err) {
    throw new FileAxiomError(
      `Could not parse bulk operation request: "${prompt}". ` +
        'Try being more specific, e.g., "@axiom /bulk rename all .js files to .ts".',
      'INVALID_INPUT',
    );
  }
}

/**
 * Detects if a prompt is requesting a bulk operation (multiple files).
 * Returns true for prompts with "all", "every", plural forms, or comma-separated lists.
 */
export function isBulkOperation(prompt: string): boolean {
  const lowerPrompt = prompt.toLowerCase();
  
  // Check for bulk keywords
  const bulkKeywords = [
    /\ball\b/,           // "all files"
    /\bevery\b/,         // "every .js file"
    /\beaches?\b/,       // "each file"
    /\bmultiple\b/,      // "multiple files"
    /\bfiles\b/,         // plural "files" (not "file")
    /\band\b.*\band\b/,  // "X and Y and Z"
    /,.*,/,              // comma-separated list "X, Y, Z"
  ];

  return bulkKeywords.some(regex => regex.test(lowerPrompt));
}
