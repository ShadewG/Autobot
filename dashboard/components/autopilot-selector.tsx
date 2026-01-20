"use client";

import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { AutopilotMode } from "@/lib/types";
import { requestsAPI } from "@/lib/api";
import { Bot, Eye, Hand, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const MODES: { value: AutopilotMode; label: string; icon: React.ReactNode; description: string }[] = [
  {
    value: "AUTO",
    label: "Full Auto",
    icon: <Bot className="h-4 w-4" />,
    description: "AI executes actions automatically",
  },
  {
    value: "SUPERVISED",
    label: "Supervised",
    icon: <Eye className="h-4 w-4" />,
    description: "AI proposes, human approves",
  },
  {
    value: "MANUAL",
    label: "Manual",
    icon: <Hand className="h-4 w-4" />,
    description: "Human controls all actions",
  },
];

const MODE_COLORS: Record<AutopilotMode, string> = {
  AUTO: "bg-green-100 text-green-700 border-green-300",
  SUPERVISED: "bg-blue-100 text-blue-700 border-blue-300",
  MANUAL: "bg-gray-100 text-gray-700 border-gray-300",
};

interface AutopilotSelectorProps {
  requestId: string;
  currentMode: AutopilotMode;
  onModeChange?: (mode: AutopilotMode) => void;
  compact?: boolean;
}

export function AutopilotSelector({
  requestId,
  currentMode,
  onModeChange,
  compact = false,
}: AutopilotSelectorProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const [mode, setMode] = useState<AutopilotMode>(currentMode);

  const currentModeConfig = MODES.find((m) => m.value === mode) || MODES[1];

  const handleModeChange = async (newMode: AutopilotMode) => {
    if (newMode === mode) return;

    setIsUpdating(true);
    try {
      await requestsAPI.setAutopilotMode(requestId, newMode);
      setMode(newMode);
      onModeChange?.(newMode);
    } catch (error) {
      console.error("Failed to update autopilot mode:", error);
    } finally {
      setIsUpdating(false);
    }
  };

  if (compact) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-6 px-2 gap-1", MODE_COLORS[mode])}
            disabled={isUpdating}
          >
            {isUpdating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              currentModeConfig.icon
            )}
            <span className="text-xs">{currentModeConfig.label}</span>
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {MODES.map((m) => (
            <DropdownMenuItem
              key={m.value}
              onClick={() => handleModeChange(m.value)}
              className={cn(mode === m.value && "bg-muted")}
            >
              <div className="flex items-center gap-2">
                {m.icon}
                <div>
                  <p className="font-medium">{m.label}</p>
                  <p className="text-xs text-muted-foreground">{m.description}</p>
                </div>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" disabled={isUpdating}>
          {isUpdating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            currentModeConfig.icon
          )}
          <span>{currentModeConfig.label}</span>
          <ChevronDown className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {MODES.map((m) => (
          <DropdownMenuItem
            key={m.value}
            onClick={() => handleModeChange(m.value)}
            className={cn("flex items-start gap-3 py-2", mode === m.value && "bg-muted")}
          >
            <div className={cn("mt-0.5", mode === m.value && "text-primary")}>
              {m.icon}
            </div>
            <div>
              <p className={cn("font-medium", mode === m.value && "text-primary")}>
                {m.label}
              </p>
              <p className="text-xs text-muted-foreground">{m.description}</p>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
