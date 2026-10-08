import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  createMcpHandler,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

// Validators for Turnfeed's deliberately small Events contract. These are local
// schemas for the documented extension, not a complete MCP Events schema package.
const Metadata = z.record(z.string(), z.unknown());
const EmptyArguments = z.object({}).strict();
const EventName = z.literal('turnfeed.reply.created');
const CallbackUrl = z.string().min(1).max(2048);
const EmptyInputSchema = z.object({
  type: z.literal('object'),
  properties: z.object({}).strict(),
  additionalProperties: z.literal(false),
}).strict();
const ReplyPayloadSchema = z.object({
  type: z.literal('object'),
  properties: z.object({
    postId: z.object({
      type: z.literal('string'), minLength: z.literal(1), maxLength: z.literal(4096),
    }).strict(),
    replyId: z.object({
      type: z.literal('string'), pattern: z.literal('^reply-[1-9][0-9]*$'),
    }).strict(),
  }).strict(),
  required: z.tuple([z.literal('postId'), z.literal('replyId')]),
  additionalProperties: z.literal(false),
}).strict();

export const EventsListParams = z.object({
  // This single-event catalog has no subsequent pages.
  cursor: z.literal('').optional(),
  _meta: Metadata.optional(),
}).strict();
export const EventsListResult = z.object({
  events: z.array(z.object({
    name: EventName,
    description: z.string().min(1).max(2048),
    delivery: z.tuple([z.literal('webhook')]),
    inputSchema: EmptyInputSchema,
    payloadSchema: ReplyPayloadSchema,
    _meta: Metadata.optional(),
  }).strict()).max(1),
  _meta: Metadata.optional(),
}).strict();
export const EventsSubscribeParams = z.object({
  name: EventName,
  arguments: EmptyArguments.optional().default({}),
  delivery: z.object({
    mode: z.literal('webhook'),
    url: CallbackUrl,
    secret: z.string().min(1).max(512),
  }).strict(),
  cursor: z.string().max(1024).nullable().optional(),
  ttlMs: z.number().int().positive().safe().nullable().optional(),
  _meta: Metadata.optional(),
}).strict();
export const EventsSubscribeResult = z.object({
  id: z.string().min(1).max(128),
  refreshBefore: z.string().datetime({ offset: true }).nullable(),
  cursor: z.null(),
  truncated: z.literal(false),
  _meta: Metadata.optional(),
}).strict();
export const EventsUnsubscribeParams = z.object({
  name: EventName,
  arguments: EmptyArguments.optional().default({}),
  delivery: z.object({ mode: z.literal('webhook'), url: CallbackUrl }).strict(),
  _meta: Metadata.optional(),
}).strict();
export const EventsUnsubscribeResult = z.object({ _meta: Metadata.optional() }).strict();

/**
 * Build the separate candidate endpoint using the public SDK2 HTTP entry.
 *
 * The caller must verify OAuth and enforce Origin/Host policy before calling
 * `handler.fetch(request, { authInfo: verifiedAuthInfo, parsedBody })`. The SDK
 * passes that trusted authInfo to `ctx.http.authInfo` in every method/tool
 * callback; it does not verify tokens or derive identity from request headers.
 * Application metadata remains untrusted at `ctx.mcpReq._meta`, and reserved
 * protocol metadata is available at `ctx.mcpReq.envelope`.
 *
 * registerTools receives the SDK2 McpServer plus its factory context and must
 * register the canonical tool handlers, including their authorization checks.
 * events callbacks receive (validatedParams, nativeSdkContext) and must enforce
 * read authorization, owner scoping, callback policy and subscription limits.
 * Shape validation here does not grant authority to perform any operation.
 */
export function createEventsMcpHandler({
  registerTools,
  events,
  serverInfo = { name: 'turnfeed', version: '4.0.0' },
  instructions,
  maxRequestBodySize = 64 * 1024,
}) {
  if (typeof registerTools !== 'function') throw new TypeError('registerTools is required');
  for (const operation of ['list', 'subscribe', 'unsubscribe']) {
    if (typeof events?.[operation] !== 'function') {
      throw new TypeError(`events.${operation} is required`);
    }
  }
  return createMcpHandler(async (factoryContext) => {
    const server = new McpServer(serverInfo, {
      instructions,
      capabilities: {
        tools: {},
        ...(factoryContext.era === 'modern' ? { events: {} } : {}),
      },
    });
    await registerTools(server, factoryContext);
    if (factoryContext.era === 'modern') {
      for (const [operation, params, result] of [
        ['list', EventsListParams, EventsListResult],
        ['subscribe', EventsSubscribeParams, EventsSubscribeResult],
        ['unsubscribe', EventsUnsubscribeParams, EventsUnsubscribeResult],
      ]) {
        server.server.setRequestHandler(`events/${operation}`, { params, result }, async (input, ctx) => {
          const output = result.safeParse(await events[operation](input, ctx));
          // The SDK's custom result schema supplies typing, not validation.
          // Return a bounded error rather than exposing malformed private data.
          if (!output.success) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, 'Invalid Events handler result');
          }
          return output.data;
        });
      }
    }
    return server;
  }, { responseMode: 'json', keepAliveMs: 0, maxRequestBodySize });
}
