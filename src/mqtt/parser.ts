import { parseTopic } from "./topics.js";
import { logger } from "../utils/logger.js";
import { rawTelemetrySchema, normalizeTelemetry } from "../validation/telemetry.schema.js";
import { rawStateSchema, normalizeDeviceState } from "../validation/state.schema.js";
import { parseStatusPayload, normalizeDeviceStatus } from "../validation/status.schema.js";
import { rawEventSchema, normalizeDeviceEvent } from "../validation/event.schema.js";
import {
  NormalizedTelemetry,
  NormalizedDeviceState,
  NormalizedDeviceStatus,
  NormalizedDeviceEvent,
} from "../types/index.js";

export type MessageParseResult =
  | { success: true; type: "telemetry"; data: NormalizedTelemetry }
  | { success: true; type: "state"; data: NormalizedDeviceState }
  | { success: true; type: "status"; data: NormalizedDeviceStatus }
  | { success: true; type: "event"; data: NormalizedDeviceEvent }
  | { success: false; error: string; rawTopic: string; rawPayload?: string };

/**
 * Safely parses and validates an incoming MQTT message from topic and payload.
 * Will NEVER throw or crash the process on corrupted, truncated, or invalid data.
 */
export function parseIncomingMessage(
  topic: string,
  payloadBuffer: Buffer | string,
  receivedAt: Date = new Date(),
): MessageParseResult {
  const parsedTopic = parseTopic(topic);
  if (!parsedTopic) {
    const errorMsg = `Unrecognized or invalid NEX-GAS topic: "${topic}"`;
    logger.warn(errorMsg, { topic });
    return { success: false, error: errorMsg, rawTopic: topic };
  }

  const rawString =
    typeof payloadBuffer === "string"
      ? payloadBuffer
      : payloadBuffer.toString("utf-8");

  const { deviceId, type } = parsedTopic;

  // Handle status topic separately (supports bare string "online"/"offline" as well as JSON)
  if (type === "status") {
    const statusPayload = parseStatusPayload(rawString);
    if (!statusPayload) {
      const errorMsg = `Invalid status payload on topic "${topic}": "${rawString.substring(0, 100)}"`;
      logger.warn(errorMsg, { topic, rawString });
      return { success: false, error: errorMsg, rawTopic: topic, rawPayload: rawString };
    }
    return {
      success: true,
      type: "status",
      data: normalizeDeviceStatus(deviceId, statusPayload, receivedAt),
    };
  }

  // All other topics (telemetry, state, event) require valid JSON
  let json: unknown;
  try {
    json = JSON.parse(rawString);
  } catch (err) {
    const errorMsg = `Malformed JSON on topic "${topic}": ${(err as Error).message}`;
    logger.warn(errorMsg, { topic, rawSnippet: rawString.substring(0, 150) });
    return { success: false, error: errorMsg, rawTopic: topic, rawPayload: rawString };
  }

  if (typeof json !== "object" || json === null) {
    const errorMsg = `Payload on topic "${topic}" is not a JSON object`;
    logger.warn(errorMsg, { topic, rawString });
    return { success: false, error: errorMsg, rawTopic: topic, rawPayload: rawString };
  }

  switch (type) {
    case "telemetry": {
      const validation = rawTelemetrySchema.safeParse(json);
      if (!validation.success) {
        const errorMsg = `Telemetry validation failed on "${topic}": ${validation.error.message}`;
        logger.warn(errorMsg, { topic, errors: validation.error.format() });
        return { success: false, error: errorMsg, rawTopic: topic, rawPayload: rawString };
      }
      return {
        success: true,
        type: "telemetry",
        data: normalizeTelemetry(deviceId, validation.data, receivedAt),
      };
    }

    case "state": {
      const validation = rawStateSchema.safeParse(json);
      if (!validation.success) {
        const errorMsg = `State validation failed on "${topic}": ${validation.error.message}`;
        logger.warn(errorMsg, { topic, errors: validation.error.format() });
        return { success: false, error: errorMsg, rawTopic: topic, rawPayload: rawString };
      }
      return {
        success: true,
        type: "state",
        data: normalizeDeviceState(deviceId, validation.data, receivedAt),
      };
    }

    case "event": {
      const validation = rawEventSchema.safeParse(json);
      if (!validation.success) {
        const errorMsg = `Event validation failed on "${topic}": ${validation.error.message}`;
        logger.warn(errorMsg, { topic, errors: validation.error.format() });
        return { success: false, error: errorMsg, rawTopic: topic, rawPayload: rawString };
      }
      return {
        success: true,
        type: "event",
        data: normalizeDeviceEvent(deviceId, validation.data, receivedAt),
      };
    }

    default: {
      const errorMsg = `Unhandled topic type "${type}" on "${topic}"`;
      logger.warn(errorMsg, { topic });
      return { success: false, error: errorMsg, rawTopic: topic, rawPayload: rawString };
    }
  }
}