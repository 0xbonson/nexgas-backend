import {
  NormalizedTelemetry,
  NormalizedDeviceState,
  NormalizedDeviceEvent,
  EventSeverity,
} from "../types/index.js";

/**
 * Maps normalized telemetry to the exact field names expected by NeX-Gas-Frontend (src/lib/types.ts).
 */
export function formatTelemetryForFrontend(t: NormalizedTelemetry) {
  return {
    h2sBefore: t.h2sBefore,
    h2sAfter: t.h2sAfter,
    ch4: t.ch4Estimate,
    leak: t.leakPpm,
    pressureDigester: t.pressureDigesterKpa,
    pressureCollector: t.pressureCollectorKpa,
    temperature: t.temperatureC,
    humidity: t.humidityPct,
    flow: t.flowEstimateLpm,
  };
}

/**
 * Maps combined device state and telemetry into the Frontend SystemState interface.
 */
export function formatSystemStateForFrontend(
  state: NormalizedDeviceState,
  telemetry?: NormalizedTelemetry | null,
) {
  const defaultTelemetry = {
    h2sBefore: null,
    h2sAfter: null,
    ch4: null,
    leak: null,
    pressureDigester: null,
    pressureCollector: null,
    temperature: null,
    humidity: null,
    flow: null,
  };

  return {
    telemetry: telemetry ? formatTelemetryForFrontend(telemetry) : defaultTelemetry,
    valveOpen: state.valveOpen,
    valveMode: state.valveMode,
    filterHealth: state.filterHealth,
    filterWarning: state.filterWarning,
    leakWarning: state.leakWarning,
  };
}

/**
 * Maps a hardware event to the AppNotification model used in NeX-Gas-Frontend.
 */
export function formatEventToAppNotification(event: NormalizedDeviceEvent) {
  const severity = event.severity.toLowerCase() as EventSeverity;
  const isWarning = severity === "waspada" || severity === "bahaya";

  const badgeMap: Record<string, string> = {
    bahaya: "BAHAYA",
    waspada: "WASPADA",
    info: "INFO GAS",
    jadwal: "JADWAL",
  };

  const actionMap: Record<string, string> = {
    valve_closed_leak: "Protokol Keamanan",
    collector_full: "Lihat Tangki",
    pressure_uncalibrated: "Kalibrasi Sensor",
    boot: "Detail Sistem",
  };

  return {
    id: `evt-${event.type}-${event.uptimeMs}`,
    category: isWarning ? ("peringatan" as const) : ("info" as const),
    severity,
    badge: badgeMap[severity] || "INFO",
    time: event.receivedAt,
    title: event.type.replace(/_/g, " ").toUpperCase(),
    body: event.message,
    action: actionMap[event.type] || "Periksa Sistem",
    unread: true,
  };
}
