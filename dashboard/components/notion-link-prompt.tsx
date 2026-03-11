"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, X } from "lucide-react";
import { useAuth } from "./auth-provider";

interface NotionName {
  name: string;
  email: string | null;
  linked_user_id: number | null;
  linked_user_name: string | null;
}

/**
 * Shows a bottom banner prompting the user to link their Notion identity
 * if they don't have one set yet. Dismissible and remembers dismissal.
 */
export function NotionLinkPrompt() {
  const { user } = useAuth();
  const [names, setNames] = useState<NotionName[]>([]);
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;

    // Don't show if already dismissed this session
    const dismissed = sessionStorage.getItem("notion_link_dismissed");
    if (dismissed) return;

    // Check if user already has notion_name
    fetch(`/api/users/${user.id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.user?.notion_name) return; // Already linked

        // Fetch available Notion names
        return fetch("/api/users/notion-names")
          .then((r) => r.json())
          .then((nd) => {
            if (!nd.success || !nd.names?.length) return;
            const available = (nd.names as NotionName[]).filter(
              (n) => !n.linked_user_id || n.linked_user_id === user.id
            );
            if (available.length > 0) {
              setNames(available);
              setVisible(true);
            }
          });
      })
      .catch(() => {});
  }, [user]);

  const handleSelect = async (notionName: string) => {
    if (!user) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ notion_name: notionName }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setVisible(false);
      }
    } catch {}
    setSaving(false);
  };

  const dismiss = () => {
    sessionStorage.setItem("notion_link_dismissed", "1");
    setVisible(false);
  };

  if (!visible || names.length === 0) return null;

  return (
    <div className="fixed bottom-0 inset-x-0 z-50 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="max-w-2xl mx-auto px-4 py-3">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <p className="text-sm font-medium">Link your Notion identity</p>
            <p className="text-xs text-muted-foreground">
              Select which Notion person you are so your cases sync
              automatically.
            </p>
          </div>
          <button
            onClick={dismiss}
            className="text-muted-foreground hover:text-foreground p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {names.map((n) => {
            const isTaken =
              n.linked_user_id !== null && n.linked_user_id !== user?.id;
            return (
              <Button
                key={n.name}
                variant="outline"
                size="sm"
                disabled={saving || isTaken}
                onClick={() => handleSelect(n.name)}
                className="h-7 text-xs"
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : null}
                {n.name}
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
