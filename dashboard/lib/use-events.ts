"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";

interface SSEEvent {
  event: string;
  case_id?: number;
  type?: string;
  message?: string;
  status?: string;
  substatus?: string;
  agency_name?: string;
  case_name?: string;
  trigger_type?: string;
  run_id?: number;
  current_node?: string | null;
  description?: string;
  timestamp: string;
}

/**
 * Subscribe to the server's SSE stream and:
 * 1. Show toast notifications for case status changes
 * 2. Auto-revalidate SWR caches so timelines/lists refresh
 */
export function useEventStream() {
  const { mutate } = useSWRConfig();
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || "/api";
    let es: EventSource | null = null;

    function connect() {
      es = new EventSource(`${apiBase}/events`);

      const goToCase = (caseId?: number) => ({
        label: "Show Status Here",
        onClick: () => {
          if (!caseId) return;
          window.location.href = `/requests/detail?id=${caseId}`;
        },
      });

      const revalidateCase = (caseId?: number) => {
        if (!caseId) return;
        mutate(
          (key: string) =>
            typeof key === "string" &&
            (
              key.includes(`/requests/${caseId}/workspace`) ||
              key.includes(`/requests/${caseId}/agent-runs`) ||
              key.startsWith("/requests")
            ),
          undefined,
          { revalidate: true }
        );
      };

      const handleEvent = (data: SSEEvent, namedEvent?: string) => {
        const eventType = namedEvent || data.event;
        switch (eventType) {
          case "case_update": {
            const label = data.agency_name || `Case #${data.case_id}`;
            const status = (data.substatus || data.status || "updated").replace(/_/g, " ");
            toast.info(`${label}`, {
              description: status,
              duration: 5000,
              action: goToCase(data.case_id),
            });
            revalidateCase(data.case_id);
            break;
          }
          case "message_new": {
            const from = data.agency_name || `Case #${data.case_id}`;
            toast.info("New message", {
              description: from,
              duration: 5000,
              action: goToCase(data.case_id),
            });
            revalidateCase(data.case_id);
            break;
          }
          case "run_status": {
            // Live run updates should refresh case detail without manual reload.
            revalidateCase(data.case_id);
            break;
          }
          case "proposal_update":
          case "activity_new": {
            revalidateCase(data.case_id);
            break;
          }
          default: {
            // Legacy notification payloads (unnamed SSE messages)
            if (data.type && data.message) {
              const level = data.type === "error" ? toast.error : data.type === "warning" ? toast.warning : toast.info;
              level(data.message, {
                duration: 6000,
                action: goToCase(data.case_id),
              });
              revalidateCase(data.case_id);
            }
            break;
          }
        }
      };

      es.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data) as SSEEvent;
          handleEvent(data);
        } catch {
          // ignore malformed payloads
        }
      };

      const namedEvents = ["case_update", "message_new", "proposal_update", "activity_new", "run_status", "portal_status", "stats_update"];
      const listeners: Array<{ event: string; handler: (ev: MessageEvent) => void }> = [];
      for (const eventName of namedEvents) {
        const handler = (ev: MessageEvent) => {
          try {
            const data = JSON.parse(ev.data) as SSEEvent;
            handleEvent(data, eventName);
          } catch {
            // ignore malformed payloads
          }
        };
        es.addEventListener(eventName, handler);
        listeners.push({ event: eventName, handler });
      }

      es.onerror = () => {
        // remove listeners before reconnecting
        for (const listener of listeners) {
          es?.removeEventListener(listener.event, listener.handler);
        }
        es?.close();
        // Reconnect after 5s
        reconnectTimer.current = setTimeout(connect, 5000);
      };
    }

    connect();

    return () => {
      es?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [mutate]);
}
