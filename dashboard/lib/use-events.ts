"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";

interface SSEEvent {
  event: string;
  case_id?: number;
  status?: string;
  substatus?: string;
  agency_name?: string;
  case_name?: string;
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

      es.onmessage = (msg) => {
        let data: SSEEvent;
        try {
          data = JSON.parse(msg.data);
        } catch {
          return;
        }

        switch (data.event) {
          case "case_update": {
            const label = data.agency_name || `Case #${data.case_id}`;
            const status = (data.substatus || data.status || "updated").replace(/_/g, " ");
            toast.info(`${label}`, { description: status, duration: 5000 });
            // Revalidate case list and detail workspace
            mutate((key: string) => typeof key === "string" && (key.startsWith("/requests") || key.startsWith("/api/requests")), undefined, { revalidate: true });
            break;
          }
          case "proposal_update":
          case "activity_new": {
            // Silently revalidate — no toast for every activity
            if (data.case_id) {
              mutate((key: string) => typeof key === "string" && key.includes(`${data.case_id}`) && key.includes("workspace"), undefined, { revalidate: true });
            }
            break;
          }
          case "message_new": {
            const from = data.agency_name || `Case #${data.case_id}`;
            toast.info(`New message`, { description: from, duration: 5000 });
            mutate((key: string) => typeof key === "string" && key.startsWith("/requests"), undefined, { revalidate: true });
            break;
          }
        }
      };

      es.onerror = () => {
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
