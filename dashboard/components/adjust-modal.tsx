"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
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
import { Loader2, Smile, AlertTriangle, FileText, DollarSign, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Constraint } from "@/lib/types";

interface AdjustPreset {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  instruction: string;
}

const PRESETS: AdjustPreset[] = [
  {
    id: "friendly",
    label: "More friendly",
    icon: Smile,
    instruction: "Make the tone more friendly and conversational while maintaining professionalism.",
  },
  {
    id: "firm",
    label: "More firm",
    icon: AlertTriangle,
    instruction: "Make the tone more firm and assertive, emphasizing our legal rights and deadlines.",
  },
  {
    id: "itemization",
    label: "Request itemization",
    icon: FileText,
    instruction: "Request an itemized breakdown of the fee estimate before proceeding.",
  },
  {
    id: "cap_cost",
    label: "Cap cost at $X",
    icon: DollarSign,
    instruction: "", // Will be filled dynamically
  },
  {
    id: "remove_unavailable",
    label: "Remove unavailable items",
    icon: Ban,
    instruction: "Remove any items that have been confirmed as not disclosable or not held by the agency.",
  },
];

interface AdjustModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (instruction: string) => Promise<void>;
  constraints?: Constraint[];
  isLoading?: boolean;
}

export function AdjustModal({
  open,
  onOpenChange,
  onSubmit,
  constraints,
  isLoading,
}: AdjustModalProps) {
  const [selectedPresets, setSelectedPresets] = useState<string[]>([]);
  const [customInstruction, setCustomInstruction] = useState("");
  const [costCap, setCostCap] = useState("");

  const togglePreset = (presetId: string) => {
    setSelectedPresets((prev) =>
      prev.includes(presetId)
        ? prev.filter((id) => id !== presetId)
        : [...prev, presetId]
    );
  };

  const buildInstruction = () => {
    const parts: string[] = [];

    selectedPresets.forEach((presetId) => {
      const preset = PRESETS.find((p) => p.id === presetId);
      if (preset) {
        if (presetId === "cap_cost" && costCap) {
          parts.push(`Set a maximum cost cap of $${costCap}.`);
        } else if (preset.instruction) {
          parts.push(preset.instruction);
        }
      }
    });

    if (customInstruction.trim()) {
      parts.push(customInstruction.trim());
    }

    return parts.join(" ");
  };

  const handleSubmit = async () => {
    const instruction = buildInstruction();
    if (instruction) {
      await onSubmit(instruction);
      // Reset on success
      setSelectedPresets([]);
      setCustomInstruction("");
      setCostCap("");
    }
  };

  const hasConstraints = constraints && constraints.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Adjust AI Proposal</DialogTitle>
          <DialogDescription>
            Select presets or provide custom instructions to modify the proposed action.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Quick presets */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Quick Adjustments</Label>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => {
                const Icon = preset.icon;
                const isSelected = selectedPresets.includes(preset.id);
                const isCostCap = preset.id === "cap_cost";
                const isRemoveUnavailable = preset.id === "remove_unavailable";

                // Only show "Remove unavailable" if there are constraints
                if (isRemoveUnavailable && !hasConstraints) return null;

                return (
                  <div key={preset.id} className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant={isSelected ? "default" : "outline"}
                      size="sm"
                      className="gap-1"
                      onClick={() => togglePreset(preset.id)}
                    >
                      <Icon className="h-3 w-3" />
                      {preset.label}
                    </Button>
                    {isCostCap && isSelected && (
                      <Input
                        type="number"
                        placeholder="$"
                        value={costCap}
                        onChange={(e) => setCostCap(e.target.value)}
                        className="w-20 h-8"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Show affected constraints if "remove unavailable" is selected */}
          {selectedPresets.includes("remove_unavailable") && hasConstraints && (
            <div className="bg-muted rounded-lg p-3">
              <p className="text-xs font-medium mb-2">Will remove references to:</p>
              <div className="flex flex-wrap gap-1">
                {constraints.flatMap((c) =>
                  c.affected_items.map((item, i) => (
                    <Badge key={`${c.type}-${i}`} variant="outline" className="text-[10px]">
                      {item}
                    </Badge>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Custom instruction */}
          <div className="space-y-2">
            <Label htmlFor="custom-instruction" className="text-sm font-medium">
              Additional Instructions
            </Label>
            <Textarea
              id="custom-instruction"
              placeholder="e.g., Mention the statutory deadline, add a reference to our previous correspondence..."
              value={customInstruction}
              onChange={(e) => setCustomInstruction(e.target.value)}
              rows={3}
            />
          </div>

          {/* Preview of combined instruction */}
          {(selectedPresets.length > 0 || customInstruction.trim()) && (
            <div className="bg-muted rounded-lg p-3">
              <p className="text-xs font-medium mb-1 text-muted-foreground">
                Combined instruction:
              </p>
              <p className="text-sm">{buildInstruction()}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isLoading || (!selectedPresets.length && !customInstruction.trim())}
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Apply Adjustments
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
