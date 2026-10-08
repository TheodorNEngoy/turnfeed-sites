import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const MAX_SPANS = 64;
const MAX_PENDING_LINES = 128;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_REQUESTS = 1000;
const MAX_WINDOW_MS = 60 * 60 * 1000;
const PHASES = new Set([
  'auth', 'body_read', 'json_parse', 'mcp_setup', 'dispatch',
  'freshness_wait', 'handler', 'pool_acquire', 'db_lock', 'db_unlock',
  'store_sql_read', 'store_load', 'store_normalize', 'store_apply',
  'mutation', 'store_serialize', 'store_sql_write', 'text_moderation',
  'media_preflight', 'response_send',
]);
const RPC_METHODS = new Map([
  ['initialize', 'initialize'],
  ['notifications/initialized', 'initialized'],
  ['tools/list', 'tools_list'],
  ['tools/call', 'tools_call'],
]);
const BYPASS = Object.freeze({
  run: (_req, _res, fn) => fn(),
  setRpcRequest: () => {},
  measureAsync: (_phase, fn) => fn(),
  measureSync: (_phase, fn) => fn(),
});

function elapsed(start, end) {
  const value = end - start;
  return Number.isFinite(value) ? Math.round(Math.max(0, value) * 1000) / 1000 : 0;
}

// One writer per helper. These listeners create no timers or event-loop handles.
// A lifetime error listener also covers an error emitted after write's callback.
function createWriter(sink) {
  const pending = [];
  let blocked = false;
  let writing = false;
  let failed = false;

  const fail = () => {
    failed = true;
    pending.length = 0;
  };
  const write = (line) => {
    try {
      if (sink.write(line, (error) => { if (error) fail(); }) === false && !failed) {
        blocked = true;
      }
    } catch {
      fail();
    }
  };
  const flush = () => {
    if (failed || writing || blocked) return;
    writing = true;
    try {
      while (!failed && !blocked && pending.length) write(pending.shift());
    } finally {
      writing = false;
    }
  };
  try {
    if (typeof sink?.write !== 'function' || typeof sink?.on !== 'function') {
      fail();
    } else {
      sink.on('error', fail);
      sink.on('drain', () => {
        blocked = false;
        flush();
      });
    }
  } catch {
    fail();
  }
  return (line) => {
    if (failed || pending.length >= MAX_PENDING_LINES) return;
    pending.push(line);
    flush();
  };
}

/**
 * Private diagnostics for canonical POST /mcp-v2 only; the caller selects that route.
 * toolNames must come from the server's canonical registration, never request data.
 * Spans are inclusive and may overlap. A still-active span is clipped at response
 * completion and marked endedByResponse; later completions cannot extend the record.
 * Drops from the bounded writer are diagnostic loss, not evidence of absent requests.
 */
export function createRequestTiming({ enabled, toolNames, sink, expiresAt, maxRequests = MAX_REQUESTS } = {}) {
  if (enabled !== true) return BYPASS;

  let storage;
  let writeLine;
  const knownTools = new Set();
  let requestLimit;
  try {
    const now = Date.now();
    if (expiresAt !== undefined && (
      typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) ||
      expiresAt <= now || expiresAt > now + MAX_WINDOW_MS
    )) return BYPASS;
    if (!Number.isInteger(maxRequests) || maxRequests < 0) return BYPASS;
    requestLimit = Math.min(maxRequests, MAX_REQUESTS);
    if (requestLimit === 0) return BYPASS;
    // The catalog has 24 tools. Keep even accidental factory input bounded.
    let count = 0;
    for (const name of toolNames ?? []) {
      if (count++ >= 24) break;
      if (typeof name === 'string' && name.length <= 64) knownTools.add(name);
    }
    storage = new AsyncLocalStorage();
    writeLine = createWriter(sink ?? process.stdout);
  } catch {
    return BYPASS;
  }
  let requests = 0;

  function startSpan(phase) {
    try {
      const context = storage.getStore();
      if (!context || context.closed || !PHASES.has(phase)) return;
      if (context.spans.length >= MAX_SPANS - 1) {
        context.spansTruncated = true;
        return;
      }
      const span = { phase, started: performance.now(), ended: undefined };
      context.spans.push(span);
      return { context, span };
    } catch {
      return undefined;
    }
  }

  function endSpan(active) {
    try {
      if (active && !active.context.closed) active.span.ended = performance.now();
    } catch {
      // Diagnostics must not replace an application value or error.
    }
  }

  function measureSync(phase, fn) {
    const active = startSpan(phase);
    if (!active) return fn();
    try {
      return fn();
    } finally {
      endSpan(active);
    }
  }

  function measureAsync(phase, fn) {
    const active = startSpan(phase);
    if (!active) return fn();
    try {
      return Promise.resolve(fn()).then(
        (value) => { endSpan(active); return value; },
        (error) => { endSpan(active); throw error; },
      );
    } catch (error) {
      endSpan(active);
      throw error;
    }
  }

  function setRpcRequest(parsedBody) {
    try {
      const context = storage.getStore();
      if (!context || context.closed) return;
      context.rpcMethod = 'other';
      context.tool = undefined;
      if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) return;
      context.rpcMethod = RPC_METHODS.get(parsedBody.method) ?? 'other';
      if (context.rpcMethod === 'tools_call') {
        const name = parsedBody.params?.name;
        context.tool = typeof name === 'string' && knownTools.has(name) ? name : 'other';
      }
    } catch {
      // Do not retain input objects or report free-form input/exception details.
    }
  }

  function run(req, res, fn) {
    if (requests >= requestLimit) return fn();
    let expired;
    try {
      expired = expiresAt !== undefined && Date.now() >= expiresAt;
    } catch {
      return fn();
    }
    if (expired) return fn();

    let context;
    let onFinish;
    let onClose;
    const cleanup = () => {
      try { res.removeListener('finish', onFinish); } catch {}
      try { res.removeListener('close', onClose); } catch {}
    };
    try {
      requests += 1;
      const started = performance.now();
      const startedUtc = new Date().toISOString();
      context = {
        requestId: randomUUID(),
        startedUtc,
        started,
        authPresent: Object.hasOwn(req?.headers ?? {}, 'authorization'),
        rpcMethod: 'other',
        tool: undefined,
        spans: [],
        spansTruncated: false,
        closed: false,
      };
      const complete = (completion) => {
        if (context.closed) return;
        context.closed = true;
        cleanup();
        try {
          const ended = performance.now();
          const httpStatus = res.statusCode;
          if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 999) return;
          const durationMs = elapsed(context.started, ended);
          const spans = [{ phase: 'request', startOffsetMs: 0, durationMs }];
          for (const span of context.spans) {
            const output = {
              phase: span.phase,
              startOffsetMs: elapsed(context.started, span.started),
              durationMs: elapsed(span.started, span.ended ?? ended),
            };
            if (span.ended === undefined) output.endedByResponse = true;
            spans.push(output);
          }
          // Construct every field explicitly; never spread request/context data.
          const record = {
            schemaVersion: 'turnfeed-request-timing-v1',
            requestId: context.requestId,
            startedUtc: context.startedUtc,
            route: 'mcp_v2',
            rpcMethod: context.rpcMethod,
            ...(context.tool === undefined ? {} : { tool: context.tool }),
            authPresent: context.authPresent,
            httpStatus,
            completion,
            durationMs,
            spans,
            spansTruncated: context.spansTruncated,
          };
          let line = `${JSON.stringify(record)}\n`;
          while (Buffer.byteLength(line) > MAX_RECORD_BYTES && spans.length > 1) {
            spans.pop();
            record.spansTruncated = true;
            line = `${JSON.stringify(record)}\n`;
          }
          if (Buffer.byteLength(line) <= MAX_RECORD_BYTES) writeLine(line);
        } catch {
          // Drop a failed diagnostic rather than affecting the HTTP response.
        } finally {
          context.spans.length = 0;
        }
      };
      onFinish = () => complete('finish');
      onClose = () => complete('aborted');
      res.once('finish', onFinish);
      res.once('close', onClose);
    } catch {
      if (context) context.closed = true;
      cleanup();
      return fn();
    }

    // A failure to enter ALS must not skip the action; an action's own throw must
    // propagate unchanged and must never cause the action to execute twice.
    let entered = false;
    try {
      return storage.run(context, () => {
        entered = true;
        return fn();
      });
    } catch (error) {
      if (entered) throw error;
      context.closed = true;
      cleanup();
      return fn();
    }
  }

  return { run, setRpcRequest, measureAsync, measureSync };
}
