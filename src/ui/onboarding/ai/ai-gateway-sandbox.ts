import type { McpApp } from '@privos_ai/app-react';

import { sanitizeAiDiagnosticText } from '../../../onboarding/ai/diagnostics';

export type AiAttemptState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AiDispatchInput {
  readonly operationId: string;
  readonly prompt: string;
  readonly systemContext?: string;
  readonly signal?: AbortSignal;
}

export interface AiAttemptStatus {
  readonly state: AiAttemptState;
  readonly text?: string;
  readonly error?: string;
  readonly errorCode?: string;
  readonly phase?: string;
  readonly diagnosticError?: string;
}

export interface AiGateway {
  dispatch(input: AiDispatchInput): Promise<{ readonly attemptRef: string }>;
  status(attemptRef: string, signal?: AbortSignal): Promise<AiAttemptStatus>;
  cancel?(attemptRef: string, signal?: AbortSignal): Promise<void>;
}

export type AiGatewayErrorCode =
  | 'AI_PERMISSION_DENIED'
  | 'AI_REQUEST_FAILED'
  | 'AI_RESPONSE_INVALID';

export class AiGatewayError extends Error {
  constructor(readonly code: AiGatewayErrorCode, message: string) {
    super(message);
    this.name = 'AiGatewayError';
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function responseError(statusCode: number, body: unknown): AiGatewayError {
  const value = record(body);
  const detail = [value.error, value.message].find((candidate): candidate is string => typeof candidate === 'string');
  if (statusCode === 401 || statusCode === 403 || detail === 'OPTIONAL_PERMISSION_NOT_GRANTED') {
    return new AiGatewayError(
      'AI_PERMISSION_DENIED',
      'Chưa được cấp quyền tạo nội dung bằng AI trong room này.',
    );
  }
  return new AiGatewayError(
    'AI_REQUEST_FAILED',
    detail ?? `PrivOS Sandbox trả về HTTP ${statusCode}.`,
  );
}

function normalizeRestResponse(response: unknown): { statusCode: number; body: unknown } {
  const envelope = record(response);
  const statusCode = typeof envelope.statusCode === 'number'
    ? envelope.statusCode
    : envelope.success === false ? 400 : 200;
  return {
    statusCode,
    body: Object.prototype.hasOwnProperty.call(envelope, 'body') ? envelope.body : response,
  };
}

function requestError(error: unknown): AiGatewayError {
  if (error instanceof AiGatewayError) return error;
  const value = record(error);
  const message = error instanceof Error ? error.message : String(error || '');
  if (
    value.code === 'OPTIONAL_PERMISSION_NOT_GRANTED'
    || /App is not permitted to call .*agents\.sandbox\./i.test(message)
  ) {
    return new AiGatewayError(
      'AI_PERMISSION_DENIED',
      'Chưa được cấp quyền tạo nội dung bằng AI trong room này.',
    );
  }
  return new AiGatewayError('AI_REQUEST_FAILED', message || 'Không thể kết nối PrivOS Sandbox.');
}

function requireSuccess(statusCode: number, body: unknown): Record<string, unknown> {
  if (statusCode < 200 || statusCode >= 300) throw responseError(statusCode, body);
  return record(body);
}

const ATTEMPT_STATES = new Set<AiAttemptState>([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export function createSandboxAiGateway(app: Pick<McpApp, 'rest'>, roomId: string): AiGateway {
  const boundRoomId = roomId.trim();
  if (!boundRoomId) throw new AiGatewayError('AI_REQUEST_FAILED', 'Không xác định được room để tạo nội dung AI.');

  return {
    async cancel(attemptRef, signal) {
      if (signal?.aborted) throw signal.reason;
      let response: unknown;
      try {
        response = await app.rest({
          method: 'POST',
          path: 'agents.sandbox.attempt-cancel',
          timeoutMs: 15_000,
          body: { roomId: boundRoomId, attemptId: attemptRef },
        });
      } catch (error) {
        throw requestError(error);
      }
      const normalized = normalizeRestResponse(response);
      requireSuccess(normalized.statusCode, normalized.body);
    },

    async dispatch(input) {
      if (input.signal?.aborted) throw input.signal.reason;
      // `sandbox:generate` authorizes this current-user, room-bound async generation call.
      let response: unknown;
      try {
        response = await app.rest({
          method: 'POST',
          path: 'agents.sandbox.generate-async',
          timeoutMs: 15_000,
          body: {
            roomId: boundRoomId,
            operationId: input.operationId,
            prompt: input.prompt,
            ...(input.systemContext === undefined ? {} : { systemContext: input.systemContext }),
          },
        });
      } catch (error) {
        throw requestError(error);
      }
      const normalized = normalizeRestResponse(response);
      const body = requireSuccess(normalized.statusCode, normalized.body);
      if (typeof body.attemptId !== 'string' || !body.attemptId.trim()) {
        throw new AiGatewayError('AI_RESPONSE_INVALID', 'PrivOS Sandbox không trả về mã attempt hợp lệ.');
      }
      return { attemptRef: body.attemptId };
    },

    async status(attemptRef, signal) {
      if (signal?.aborted) throw signal.reason;
      // `sandbox:generate` also authorizes observing the exact attempt dispatched above.
      let response: unknown;
      try {
        response = await app.rest({
          method: 'GET',
          path: 'agents.sandbox.attempt-status',
          timeoutMs: 15_000,
          query: { roomId: boundRoomId, attemptId: attemptRef },
        });
      } catch (error) {
        throw requestError(error);
      }
      const normalized = normalizeRestResponse(response);
      const body = requireSuccess(normalized.statusCode, normalized.body);
      if (typeof body.status !== 'string' || !ATTEMPT_STATES.has(body.status as AiAttemptState)) {
        throw new AiGatewayError('AI_RESPONSE_INVALID', 'PrivOS Sandbox trả về trạng thái attempt không hợp lệ.');
      }
      const summary: AiAttemptStatus = {
        state: body.status as AiAttemptState,
        ...(typeof body.text === 'string' ? { text: body.text } : {}),
        ...(sanitizeAiDiagnosticText(body.error) ? { error: sanitizeAiDiagnosticText(body.error) } : {}),
      };
      if (summary.state !== 'failed' && summary.state !== 'cancelled') return summary;

      try {
        const observationResponse = await app.rest({
          method: 'GET',
          path: 'agents.sandbox.attempt-observation',
          timeoutMs: 15_000,
          query: { roomId: boundRoomId, attemptId: attemptRef },
        });
        const observationNormalized = normalizeRestResponse(observationResponse);
        const observation = requireSuccess(
          observationNormalized.statusCode,
          observationNormalized.body,
        );
        const terminalCause = record(observation.terminalCause);
        const terminalMessage = sanitizeAiDiagnosticText(terminalCause.message);
        const terminalCode = sanitizeAiDiagnosticText(terminalCause.code);
        const phase = sanitizeAiDiagnosticText(observation.phase);
        return {
          ...summary,
          ...(terminalMessage ? { error: terminalMessage } : {}),
          ...(terminalCode ? { errorCode: terminalCode } : {}),
          ...(phase ? { phase } : {}),
        };
      } catch (error) {
        return {
          ...summary,
          diagnosticError: sanitizeAiDiagnosticText(requestError(error).message)
            ?? 'Không đọc được chi tiết attempt từ PrivOS Sandbox.',
        };
      }
    },
  };
}
