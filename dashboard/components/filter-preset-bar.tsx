"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import type { FilterPreset } from "@/hooks/use-filter-presets";
import { cn } from "@/lib/utils";

interface FilterPresetBarProps {
  presets: FilterPreset[];
  activePresetId: string | null;
  onSelectPreset: (id: string | null) => void;
  onDeletePreset?: (id: string) => void;
}

export function FilterPresetBar({
  presets,
  activePresetId,
  onSelectPreset,
  onDeletePreset,
}: FilterPresetBarProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {presets.map((preset) => {
        const isActive = preset.id === activePresetId;
        return (
          <Button
            key={preset.id}
            variant={isActive ? "default" : "outline"}
            size="sm"
            className={cn("h-7 text-xs gap-1.5", isActive && "ring-1 ring-primary")}
            onClick={() => onSelectPreset(preset.id)}
          >
            {preset.label}
            {!preset.builtin && onDeletePreset && (
              <X
                className="h-3 w-3 ml-0.5 opacity-60 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeletePreset(preset.id);
                }}
              />
            )}
          </Button>
        );
      })}
    </div>
  );
}
