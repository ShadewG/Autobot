"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RequestTable } from "./request-table";
import type { RequestListItem } from "@/lib/types";
import { AlertCircle, PlayCircle } from "lucide-react";

interface InboxSectionsProps {
  paused: RequestListItem[];
  ongoing: RequestListItem[];
  onApprove: (id: string) => void;
  onAdjust: (id: string) => void;
  onSnooze: (id: string) => void;
}

export function InboxSections({
  paused,
  ongoing,
  onApprove,
  onAdjust,
  onSnooze,
}: InboxSectionsProps) {
  return (
    <div className="space-y-6">
      {/* Paused Section */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <AlertCircle className="h-5 w-5 text-yellow-500" />
            Paused — Needs Human Review ({paused.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RequestTable
            requests={paused}
            showQuickActions
            onApprove={onApprove}
            onAdjust={onAdjust}
            onSnooze={onSnooze}
          />
        </CardContent>
      </Card>

      {/* Ongoing Section */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <PlayCircle className="h-5 w-5 text-green-500" />
            Ongoing — Autopilot Running ({ongoing.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RequestTable requests={ongoing} />
        </CardContent>
      </Card>
    </div>
  );
}
