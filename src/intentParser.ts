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
  "operation": "find" | "rename",
  "pattern": "<glob pattern, only for find>",
  "source": "<current filename, only for rename>",
  "target": "<new filename, only for rename>"
}

Rules:
- If the user wants to search/find/list/locate files → operation = "find".
- If the user wants to rename/move/change the name → operation = "rename".
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
    vscode.LanguageModelChatMessage.User('Change Auth.js to Security.js'),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"rename","source":"Auth.js","target":"Security.js"}',
    ),
    vscode.LanguageModelChatMessage.User(
      'look for config files in the src directory',
    ),
    vscode.LanguageModelChatMessage.Assistant(
      '{"operation":"find","pattern":"src/**/config.*"}',
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
    if (!parsed.operation || !['find', 'rename'].includes(parsed.operation)) {
      throw new Error('Invalid operation');
    }
    if (parsed.operation === 'find' && !parsed.pattern) {
      throw new Error('Missing pattern for find operation');
    }
    if (parsed.operation === 'rename' && (!parsed.source || !parsed.target)) {
      throw new Error('Missing source or target for rename operation');
    }

    return parsed;
  } catch {
    // If LLM fails, attempt a basic regex fallback
    return regexFallback(prompt);
  }
}

// ── Regex Fallback ────────────────────────────────────────────

function regexFallback(prompt: string): FileAxiomIntent {
  // Detect rename: "rename X to Y", "move X to Y", "change X to Y"
  const renameMatch = prompt.match(
    /(?:rename|move|change)\s+(\S+)\s+to\s+(\S+)/i,
  );
  if (renameMatch) {
    return {
      operation: 'rename',
      source: renameMatch[1],
      target: renameMatch[2],
    };
  }

  // Detect find: "find X", "search for X", "list X", "locate X"
  const findMatch = prompt.match(
    /(?:find|search|list|locate|look\s+for)\s+(.+)/i,
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
