"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

const SNOOZE_PRESETS = [
  { id: "tomorrow", label: "Tomorrow", days: 1 },
  { id: "3days", label: "3 days", days: 3 },
  { id: "1week", label: "1 week", days: 7 },
  { id: "custom", label: "Custom", days: 0 },
] as const;

interface SnoozeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (snoozeUntil: string) => Promise<void>;
  isLoading?: boolean;
}

export function SnoozeModal({
  open,
  onOpenChange,
  onSnooze,
  isLoading,
}: SnoozeModalProps) {
  const [selectedPreset, setSelectedPreset] = useState<string>("tomorrow");
  const [customDate, setCustomDate] = useState("");

  const handleSnooze = async () => {
    let snoozeUntil: Date;

    if (selectedPreset === "custom" && customDate) {
      snoozeUntil = new Date(customDate);
    } else {
      const preset = SNOOZE_PRESETS.find((p) => p.id === selectedPreset);
      if (!preset) return;
      snoozeUntil = new Date();
      snoozeUntil.setDate(snoozeUntil.getDate() + preset.days);
    }

    await onSnooze(snoozeUntil.toISOString());
    onOpenChange(false);
  };

  const isValid =
    selectedPreset !== "custom" || (selectedPreset === "custom" && customDate);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Snooze Request
          </DialogTitle>
          <DialogDescription>
            Hide this request from your inbox until the selected date.
            You&apos;ll be reminded when it&apos;s time to take action.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Preset buttons */}
          <div className="grid grid-cols-4 gap-2">
            {SNOOZE_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                type="button"
                variant={selectedPreset === preset.id ? "default" : "outline"}
                size="sm"
                className="text-xs"
                onClick={() => setSelectedPreset(preset.id)}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          {/* Custom date picker */}
          {selectedPreset === "custom" && (
            <div className="space-y-2">
              <Label htmlFor="custom-date" className="text-sm">
                Pick a date
              </Label>
              <Input
                id="custom-date"
                type="date"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                min={new Date().toISOString().split("T")[0]}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSnooze} disabled={isLoading || !isValid}>
            {isLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Snooze
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
