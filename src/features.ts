import type { ChatCompletionRequest, ChatMessage } from './types';

export interface RequestFeatures {
  /** Estimated prompt tokens. Estimated, never trusted as exact. */
  estimated_prompt_tokens: number;
  conversation_turns: number;
  has_tools: boolean;
  has_images: boolean;
  has_attachments: boolean;
  stream: boolean;
  pinned_model: string | null;
  requested_max_tokens: number | null;
  last_user_message: string;
  system_prompt_excerpt: string;
}

/** Rough character to token ratio. Good enough for window checks, never for billing. */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function messageText(message: ChatMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .filter((t) => t.length > 0)
    .join('\n');
}

function hasImagePart(message: ChatMessage): boolean {
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => typeof part === 'object' && part !== null && 'type' in part && part.type === 'image_url');
}

function hasNonTextPart(message: ChatMessage): boolean {
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) => typeof part === 'object' && part !== null && 'type' in part && part.type !== 'text' && part.type !== 'image_url',
  );
}

/**
 * Everything computable about a request is computed here, never asked of the judge.
 */
export function extractFeatures(req: ChatCompletionRequest): RequestFeatures {
  const messages = req.messages;
  let chars = 0;
  let hasImages = false;
  let hasAttachments = false;
  let lastUser = '';
  let system = '';

  for (const message of messages) {
    const text = messageText(message);
    chars += text.length + message.role.length;
    if (hasImagePart(message)) hasImages = true;
    if (hasNonTextPart(message)) hasAttachments = true;
    if (message.role === 'user') lastUser = text;
    if (system.length === 0 && (message.role === 'system' || message.role === 'developer')) system = text;
  }

  const conversationTurns = messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;
  const maxTokens = req.max_completion_tokens ?? req.max_tokens ?? null;

  return {
    estimated_prompt_tokens: Math.ceil(chars / CHARS_PER_TOKEN),
    conversation_turns: conversationTurns,
    has_tools: (req.tools?.length ?? 0) > 0 || (req.functions?.length ?? 0) > 0,
    has_images: hasImages,
    has_attachments: hasAttachments,
    stream: req.stream === true,
    pinned_model: typeof req.model === 'string' && req.model.length > 0 ? req.model : null,
    requested_max_tokens: maxTokens,
    last_user_message: lastUser,
    system_prompt_excerpt: system,
  };
}
