import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import type { Live } from "./sandbox.ts";

export type HttpResponseRecord = {
  at: string;
  method: string;
  destination: string;
  requestHeaders: Record<string, string>;
  status: number;
  responseHeaders: Record<string, string>;
  durationMs: number;
  bytes?: number;
  complete: boolean;
  error?: string;
  requestCapture: "complete" | "truncated" | "metadata_only" | "empty";
  responseCapture: "complete" | "truncated" | "metadata_only" | "empty";
  requestBody?: CapturedBody;
  responseBody?: CapturedBody;
};

export type CapturedBody = {
  path: string;
  contentType?: string;
  capturedBytes: number;
  totalBytes: number;
  limitBytes: number;
  truncated: boolean;
};

const capturedHeaders = new Set([
  "accept",
  "content-length",
  "content-type",
  "date",
  "openai-beta",
  "openai-processing-ms",
  "anthropic-version",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-input-tokens-remaining",
  "anthropic-ratelimit-output-tokens-remaining",
  "retry-after",
  "server",
  "traceparent",
  "tracestate",
  "user-agent",
  "x-api-version",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "x-request-id",
  "request-id",
]);
const safeHeaders = (headers: Headers) =>
  Object.fromEntries([...headers].filter(([name]) => capturedHeaders.has(name)));

/**
 * Records one finished request in `live.httpResponses` for trace.jsonl: text and model bodies are saved as blobs in
 * `captureDir`, and the oldest record (with its blobs) is dropped past 1,000.
 */
export const recordHttp = (
  live: Live,
  captureDir: string,
  isModel: boolean,
  request: { method: string; url: string; headers: Headers },
  response: { status: number; headers: Headers } | null | undefined,
  requestBody: Buffer,
  responseBody: Buffer,
  info: {
    durationMs: number;
    bytes?: number;
    requestBytes?: number;
    requestLimit?: number;
    responseLimit?: number;
    complete: boolean;
    error?: string;
  },
) => {
  const saveBody = (
    direction: string,
    body: Buffer,
    totalBytes: number,
    limitBytes: number,
    contentType: string | null,
    incomplete = false,
  ): CapturedBody | undefined => {
    if (!totalBytes) return;
    if (
      !isModel &&
      !contentType?.match(
        /^(text\/|application\/(json|[^;]+\+json|xml|javascript|x-www-form-urlencoded)|application\/.*\+xml)/i,
      )
    )
      return;
    const name = `${randomUUID()}.${direction}.bin`;
    writeFileSync(`${captureDir}/${name}`, body, { flag: "wx" });
    live.httpBodyBytes += body.length;
    return {
      path: `blobs/${name}`,
      ...(contentType ? { contentType } : {}),
      capturedBytes: body.length,
      totalBytes,
      limitBytes,
      truncated: body.length < totalBytes || incomplete,
    };
  };
  const requestBytes = Math.max(info.requestBytes ?? 0, requestBody.length);
  const responseBytes = Math.max(info.bytes ?? 0, responseBody.length);
  const requestCapture = saveBody(
    "request",
    requestBody,
    requestBytes,
    info.requestLimit ?? 0,
    request.headers.get("content-type"),
  );
  const responseCapture = saveBody(
    "response",
    responseBody,
    responseBytes,
    info.responseLimit ?? 0,
    response?.headers.get("content-type") ?? null,
    !info.complete,
  );
  const captureStatus = (total: number, body?: CapturedBody) =>
    !total
      ? ("empty" as const)
      : !body
        ? ("metadata_only" as const)
        : body.truncated
          ? ("truncated" as const)
          : ("complete" as const);
  if (live.httpResponses.length === 1_000) {
    const removed = live.httpResponses.shift()!;
    for (const body of [removed.requestBody, removed.responseBody])
      if (body) {
        rmSync(`${captureDir}/${body.path.slice("blobs/".length)}`, { force: true });
        live.httpBodyBytes -= body.capturedBytes;
      }
    live.httpResponsesOmitted += 1;
  }
  live.httpResponses.push({
    at: new Date().toISOString(),
    method: request.method,
    destination: new URL(request.url).origin,
    requestHeaders: safeHeaders(request.headers),
    status: response?.status ?? 0,
    responseHeaders: response ? safeHeaders(response.headers) : {},
    durationMs: info.durationMs,
    ...(info.bytes === undefined ? {} : { bytes: info.bytes }),
    complete: info.complete,
    ...(info.error ? { error: info.error } : {}),
    requestCapture: captureStatus(requestBytes, requestCapture),
    responseCapture: captureStatus(responseBytes, responseCapture),
    ...(requestCapture ? { requestBody: requestCapture } : {}),
    ...(responseCapture ? { responseBody: responseCapture } : {}),
  });
};


type NativeRecord = Record<string, any>;
type Run = Record<string, any>;
type ToolEntry = {
  id?: string;
  name?: string;
  inputs?: unknown;
  result?: NativeRecord;
  record: NativeRecord;
};

const timestamp = (value: unknown) => {
  const date = new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const jsonInput = (value: unknown) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const piTools = (records: NativeRecord[]): ToolEntry[] =>
  records.flatMap((record): ToolEntry[] => {
    if (record.type !== "message") return [];
    const message = record.message;
    if (message?.role === "assistant")
      return (message.content ?? [])
        .filter((block: NativeRecord) => block.type === "toolCall")
        .map((block: NativeRecord) => ({
          id: block.id,
          name: block.name,
          inputs: block.arguments,
          record,
        }));
    if (message?.role === "toolResult")
      return [{ id: message.toolCallId, result: message, record }];
    return [];
  });

export const createToolRuns = (
  records: NativeRecord[],
  context: { sessionId?: string; taskId: string; traceId: string; parentRunId: string },
) => {
  const entries = piTools(records);
  const calls = new Map(
    entries.filter((entry) => entry.name && entry.id).map((entry) => [entry.id, entry]),
  );
  const runs: Run[] = [];
  const consumed = new Set<NativeRecord>();
  for (const entry of entries) {
    if (!entry.result || !entry.id) continue;
    const call = calls.get(entry.id);
    if (!call) continue;
    const result = entry.result;
    const isError = result.isError === true;
    const start = timestamp(call.record.timestamp ?? call.record.time);
    const end = timestamp(entry.record.timestamp ?? entry.record.time);
    const run: Run = {
      id: randomUUID(),
      name: call.name,
      run_type: "tool",
      trace_id: context.traceId,
      parent_run_id: context.parentRunId,
      inputs: jsonInput(call.inputs) ?? {},
      outputs: result.content,
      error: isError ? (result.error ?? { message: "tool returned an error" }) : null,
      extra: {
        metadata: {
          thread_id: context.taskId,
          broker: {
            schema_version: 1,
            source: "harness",
            harness: "pi",
            ...(context.sessionId ? { source_session_id: context.sessionId } : {}),
            tool_call_id: entry.id,
            capture_status: "complete",
            native_records: [call.record, entry.record],
          },
        },
      },
    };
    if (start) run.start_time = start;
    if (end) run.end_time = end;
    runs.push(run);
    consumed.add(call.record);
    consumed.add(entry.record);
    calls.delete(entry.id);
  }
  return { runs, unassignedRecords: records.filter((record) => !consumed.has(record)) };
};

/**
 * Rebuilds one OpenAI-style streamed chat completion into its finished message: text, reasoning,
 * tool calls, finish reason, token usage, and llama.cpp timings. Per-chunk bytes and timing are dropped.
 */
export const assembleStream = (text: string) => {
  const message: NativeRecord = { content: "", reasoning_content: "", tool_calls: [] };
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const chunk = JSON.parse(line.slice(6));
    message.id ??= chunk.id;
    message.model ??= chunk.model;
    if (chunk.usage) message.usage = chunk.usage;
    if (chunk.timings) message.timings = chunk.timings;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) message.finish_reason = choice.finish_reason;
    message.content += choice.delta?.content ?? "";
    message.reasoning_content += choice.delta?.reasoning_content ?? "";
    for (const call of choice.delta?.tool_calls ?? []) {
      const entry = (message.tool_calls[call.index] ??= {
        id: call.id,
        type: "function",
        function: { name: "", arguments: "" },
      });
      entry.function.name += call.function?.name ?? "";
      entry.function.arguments += call.function?.arguments ?? "";
    }
  }
  return message;
};

export const createModelRuns = (
  responses: NativeRecord[],
  context: { modelOrigins: Set<string>; model: string; taskId: string; traceId: string },
) =>
  responses.flatMap((response, index) => {
    if (!context.modelOrigins.has(response.destination)) return [];
    const end = timestamp(response.at);
    const httpStatus =
      response.complete && response.status < 400
        ? "complete"
        : response.complete
          ? "http_error"
          : "incomplete";
    const captureStatus =
      httpStatus !== "complete"
        ? httpStatus
        : response.requestCapture === "truncated" || response.responseCapture === "truncated"
          ? "truncated"
          : "complete";
    const run: Run = {
      id: randomUUID(),
      name: context.model,
      run_type: "llm",
      trace_id: context.traceId,
      parent_run_id: context.traceId,
      inputs: {
        request_body: response.requestBody ?? null,
        request_headers: response.requestHeaders,
        method: response.method,
        destination: response.destination,
      },
      outputs: {
        response_body: response.responseBody ?? null,
        response_headers: response.responseHeaders,
        status: response.status,
        complete: response.complete,
      },
      error:
        httpStatus === "complete"
          ? null
          : {
              status: response.status,
              ...(response.error ? { message: response.error } : {}),
              capture_status: httpStatus,
            },
      extra: {
        metadata: {
          thread_id: context.taskId,
          broker: {
            schema_version: 1,
            source: "gondolin-http",
            capture_status: captureStatus,
            http_response_index: index,
            request_capture: response.requestCapture,
            response_capture: response.responseCapture,
          },
        },
      },
    };
    if (end) {
      run.end_time = end;
      const start = new Date(new Date(end).getTime() - response.durationMs);
      if (Number.isFinite(start.getTime())) run.start_time = start.toISOString();
    }
    return [run];
  });
