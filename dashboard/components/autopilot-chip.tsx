import { Badge } from "@/components/ui/badge";
import type { AutopilotMode } from "@/lib/types";
import { AUTOPILOT_LABELS } from "@/lib/utils";
import { Bot, Eye, Hand } from "lucide-react";

const autopilotIcons: Record<AutopilotMode, React.ReactNode> = {
  AUTO: <Bot className="h-3 w-3" />,
  SUPERVISED: <Eye className="h-3 w-3" />,
  MANUAL: <Hand className="h-3 w-3" />,
};

const autopilotVariants: Record<AutopilotMode, "default" | "secondary" | "outline"> = {
  AUTO: "default",
  SUPERVISED: "secondary",
  MANUAL: "outline",
};

interface AutopilotChipProps {
  mode: AutopilotMode;
}

export function AutopilotChip({ mode }: AutopilotChipProps) {
  return (
    <Badge variant={autopilotVariants[mode]} className="gap-1">
      {autopilotIcons[mode]}
      {AUTOPILOT_LABELS[mode] || mode}
    </Badge>
  );
}
