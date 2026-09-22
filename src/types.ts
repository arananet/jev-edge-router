import { z } from 'zod';

const ContentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }).passthrough() }),
  z.object({ type: z.string() }).passthrough(),
]);

export const ChatMessageSchema = z
  .object({
    role: z.string().min(1),
    content: z.union([z.string(), z.array(ContentPartSchema), z.null()]).optional(),
    name: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional(),
    tool_call_id: z.string().optional(),
  })
  .passthrough();

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(ChatMessageSchema).min(1),
    tools: z.array(z.unknown()).optional(),
    functions: z.array(z.unknown()).optional(),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
  })
  .passthrough();

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
