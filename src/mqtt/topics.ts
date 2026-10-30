import { TopicType, ParsedTopic } from "../types/index.js";

export const BASE_TOPIC_PREFIX = "nexgas";

const VALID_DEVICE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

const VALID_TOPIC_TYPES: readonly TopicType[] = [
  "telemetry",
  "state",
  "status",
  "event",
  "cmd",
] as const;

/**
 * Validates whether a device ID conforms to safe alphanumeric/dash/underscore format.
 */
export function isValidDeviceId(deviceId: string): boolean {
  return typeof deviceId === "string" && VALID_DEVICE_ID_REGEX.test(deviceId);
}

/**
 * Returns formatted MQTT topic string for a device and topic type.
 */
export function buildTopic(deviceId: string, type: TopicType): string {
  if (!isValidDeviceId(deviceId)) {
    throw new Error(`Invalid deviceId format: "${deviceId}"`);
  }
  return `${BASE_TOPIC_PREFIX}/${deviceId}/${type}`;
}

export const getTelemetryTopic = (deviceId: string) => buildTopic(deviceId, "telemetry");
export const getStateTopic = (deviceId: string) => buildTopic(deviceId, "state");
export const getStatusTopic = (deviceId: string) => buildTopic(deviceId, "status");
export const getEventTopic = (deviceId: string) => buildTopic(deviceId, "event");
export const getCommandTopic = (deviceId: string) => buildTopic(deviceId, "cmd");

/**
 * Parses an incoming MQTT topic.
 * Returns ParsedTopic or null if topic is not a valid NEX-GAS topic.
 */
export function parseTopic(topic: string): ParsedTopic | null {
  if (!topic || typeof topic !== "string") return null;

  const parts = topic.split("/");
  if (parts.length !== 3) return null;

  const [prefix, deviceId, type] = parts;
  if (prefix !== BASE_TOPIC_PREFIX) return null;
  if (!isValidDeviceId(deviceId)) return null;
  if (!VALID_TOPIC_TYPES.includes(type as TopicType)) return null;

  return {
    raw: topic,
    deviceId,
    type: type as TopicType,
  };
}

/**
 * Generates the list of topics the backend should subscribe to.
 * Excludes the command topic ("cmd") because the backend publishes commands, while firmware subscribes.
 */
export function getSubscriptionTopics(deviceIds?: string[]): string[] {
  const typesToSubscribe: readonly TopicType[] = [
    "telemetry",
    "state",
    "status",
    "event",
  ];

  if (!deviceIds || deviceIds.length === 0) {
    return typesToSubscribe.map((type) => `${BASE_TOPIC_PREFIX}/+/${type}`);
  }

  const topics: string[] = [];
  for (const deviceId of deviceIds) {
    if (deviceId === "+") {
      return typesToSubscribe.map((type) => `${BASE_TOPIC_PREFIX}/+/${type}`);
    }
    if (isValidDeviceId(deviceId)) {
      for (const type of typesToSubscribe) {
        topics.push(buildTopic(deviceId, type));
      }
    }
  }

  return topics.length > 0
    ? topics
    : typesToSubscribe.map((type) => `${BASE_TOPIC_PREFIX}/+/${type}`);
}

/**
 * Matches an MQTT topic pattern with wildcards (+, #) against an actual topic.
 */
export function isMqttTopicMatch(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (pattern === "#") return true;

  const patternSegments = pattern.split("/");
  const topicSegments = topic.split("/");

  for (let i = 0; i < patternSegments.length; i++) {
    const p = patternSegments[i];
    if (p === "#") {
      return true; // # matches all remaining levels
    }
    if (i >= topicSegments.length) {
      return false;
    }
    if (p !== "+" && p !== topicSegments[i]) {
      return false;
    }
  }

  return patternSegments.length === topicSegments.length;
}