import { randomUUID } from "node:crypto";

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
