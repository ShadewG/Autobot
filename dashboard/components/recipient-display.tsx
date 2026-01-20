"use client";

import { Badge } from "@/components/ui/badge";
import { Mail, Globe, FileText } from "lucide-react";

interface RecipientDisplayProps {
  channel: "EMAIL" | "PORTAL" | "MAIL";
  recipientEmail?: string;
  portalProvider?: string;
  className?: string;
}

/**
 * Shows the recipient + channel for an outbound action.
 * Critical for trust - users need to know where their message is going.
 */
export function RecipientDisplay({
  channel,
  recipientEmail,
  portalProvider,
  className,
}: RecipientDisplayProps) {
  if (channel === "EMAIL" && recipientEmail) {
    return (
      <div className={className}>
        <Badge variant="outline" className="gap-1 text-xs font-normal">
          <Mail className="h-3 w-3" />
          To: {recipientEmail}
        </Badge>
      </div>
    );
  }

  if (channel === "PORTAL") {
    return (
      <div className={className}>
        <Badge variant="outline" className="gap-1 text-xs font-normal bg-blue-50 border-blue-200 text-blue-800">
          <Globe className="h-3 w-3" />
          Portal: {portalProvider || "Agency Portal"}
        </Badge>
      </div>
    );
  }

  if (channel === "MAIL") {
    return (
      <div className={className}>
        <Badge variant="outline" className="gap-1 text-xs font-normal">
          <FileText className="h-3 w-3" />
          Physical Mail
        </Badge>
      </div>
    );
  }

  return null;
}
