import type { ChatwootMessage } from "./types.js";

// Métricas de atención calculadas en código: un LLM no hace bien aritmética de fechas sobre
// cientos de mensajes, así que se le entregan los números ya hechos dentro del transcript.

type Role = "client" | "human" | "bot" | "internal";

function roleOf(m: ChatwootMessage): Role {
  if (m.message_type === 0) return "client";
  if (m.private) return "internal";
  return m.sender?.type === "agent_bot" ? "bot" : "human";
}

export function formatDuration(seconds: number): string {
  const min = Math.round(seconds / 60);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(times: number[]): string {
  if (times.length === 0) return "sin datos";
  const s = [...times].sort((a, b) => a - b);
  return (
    `mediana ${formatDuration(percentile(s, 0.5))} · p90 ${formatDuration(percentile(s, 0.9))} · ` +
    `máx ${formatDuration(s[s.length - 1])} (${s.length} respuestas)`
  );
}

/**
 * Tiempo de respuesta = desde el primer mensaje de cliente sin responder hasta la siguiente
 * respuesta pública, dentro de la misma conversación. Corre 24/7 (no descuenta horario de atención).
 */
export function computeMetrics(messages: ChatwootMessage[], formatDate: (epoch: number) => string): string[] {
  const counts: Record<Role, number> = { client: 0, human: 0, bot: 0, internal: 0 };
  const anyTimes: number[] = [];
  const humanTimes: number[] = [];
  const byAgent = new Map<string, { messages: number; times: number[] }>();
  let unansweredAny = 0;
  let unansweredHuman = 0;

  const byConversation = new Map<number, ChatwootMessage[]>();
  for (const m of messages) {
    counts[roleOf(m)]++;
    const list = byConversation.get(m.conversation_id ?? 0) ?? [];
    list.push(m);
    byConversation.set(m.conversation_id ?? 0, list);
  }

  for (const list of byConversation.values()) {
    let pendingAny: number | null = null;
    let pendingHuman: number | null = null;
    for (const m of list) {
      const role = roleOf(m);
      if (role === "client") {
        pendingAny ??= m.created_at;
        pendingHuman ??= m.created_at;
      } else if (role === "human" || role === "bot") {
        if (pendingAny !== null) anyTimes.push(m.created_at - pendingAny);
        pendingAny = null;
        if (role === "human") {
          const name = m.sender?.name?.trim() || "(sin remitente: plantillas o API)";
          const agent = byAgent.get(name) ?? { messages: 0, times: [] };
          agent.messages++;
          if (pendingHuman !== null) {
            humanTimes.push(m.created_at - pendingHuman);
            agent.times.push(m.created_at - pendingHuman);
          }
          pendingHuman = null;
          byAgent.set(name, agent);
        }
      }
    }
    if (pendingAny !== null) unansweredAny++;
    if (pendingHuman !== null) unansweredHuman++;
  }

  if (messages.length === 0) return ["Métricas: sin mensajes."];
  const lines = [
    "Métricas de atención (calculadas por el sistema a partir de las fechas reales; úsalas en vez de estimar):",
    `- Período: ${formatDate(messages[0].created_at)} → ${formatDate(messages[messages.length - 1].created_at)}`,
    `- Mensajes: cliente ${counts.client} · agentes ${counts.human} · bot ${counts.bot} · notas internas ${counts.internal}`,
    `- Tiempo hasta la primera respuesta (humano o bot): ${summarize(anyTimes)}`,
  ];
  if (counts.bot > 0) lines.push(`- Tiempo hasta la primera respuesta HUMANA: ${summarize(humanTimes)}`);
  lines.push(
    `- Conversaciones que terminan con mensajes del cliente sin respuesta posterior: ${unansweredAny}` +
      (counts.bot > 0 ? ` (sin respuesta humana: ${unansweredHuman})` : "") +
      " — incluye cierres normales como un \"gracias\" final",
  );
  for (const [name, a] of [...byAgent].sort((x, y) => y[1].messages - x[1].messages)) {
    lines.push(`- Agente ${name}: ${a.messages} mensajes; tiempo de respuesta ${summarize(a.times)}`);
  }
  lines.push("- Los tiempos corren 24/7: no descuentan noches, fines de semana ni horario de atención.");
  return lines;
}
