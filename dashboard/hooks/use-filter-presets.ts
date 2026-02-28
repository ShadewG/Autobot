"use client";

import { useState, useCallback, useEffect } from "react";
import type { PauseReason } from "@/lib/types";

export interface FilterState {
  gateTypes: Set<PauseReason>;
  showOnlyOverdue: boolean;
  waitingSubFilter: "all" | "scheduled" | "no_response";
  showOnlyUnknownAgency: boolean;
  showOnlyOutOfSync: boolean;
}

export interface FilterPreset {
  id: string;
  label: string;
  builtin: boolean;
  filter: Omit<FilterState, "gateTypes"> & { gateTypes: PauseReason[] };
}

const STORAGE_KEY = "foia-filter-presets";

const BUILTIN_PRESETS: FilterPreset[] = [
  {
    id: "urgent-decisions",
    label: "My urgent decisions",
    builtin: true,
    filter: {
      gateTypes: [],
      showOnlyOverdue: true,
      waitingSubFilter: "all",
      showOnlyUnknownAgency: false,
      showOnlyOutOfSync: false,
    },
  },
  {
    id: "overdue-waiting",
    label: "Overdue waiting",
    builtin: true,
    filter: {
      gateTypes: [],
      showOnlyOverdue: true,
      waitingSubFilter: "all",
      showOnlyUnknownAgency: false,
      showOnlyOutOfSync: false,
    },
  },
  {
    id: "unknown-agency",
    label: "Unknown agency",
    builtin: true,
    filter: {
      gateTypes: [],
      showOnlyOverdue: false,
      waitingSubFilter: "all",
      showOnlyUnknownAgency: true,
      showOnlyOutOfSync: false,
    },
  },
  {
    id: "out-of-sync",
    label: "Out of sync",
    builtin: true,
    filter: {
      gateTypes: [],
      showOnlyOverdue: false,
      waitingSubFilter: "all",
      showOnlyUnknownAgency: false,
      showOnlyOutOfSync: true,
    },
  },
];

export function useFilterPresets() {
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [customPresets, setCustomPresets] = useState<FilterPreset[]>([]);

  // Load custom presets from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setCustomPresets(JSON.parse(stored));
      }
    } catch {
      // ignore parse errors
    }
  }, []);

  const allPresets = [...BUILTIN_PRESETS, ...customPresets];

  const activePreset = activePresetId
    ? allPresets.find((p) => p.id === activePresetId) ?? null
    : null;

  const selectPreset = useCallback(
    (presetId: string | null) => {
      setActivePresetId((prev) => (prev === presetId ? null : presetId));
    },
    []
  );

  const saveCustomPreset = useCallback(
    (label: string, filter: FilterState) => {
      const preset: FilterPreset = {
        id: `custom-${Date.now()}`,
        label,
        builtin: false,
        filter: {
          ...filter,
          gateTypes: Array.from(filter.gateTypes),
        },
      };
      setCustomPresets((prev) => {
        const next = [...prev, preset];
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // ignore storage errors
        }
        return next;
      });
    },
    []
  );

  const deleteCustomPreset = useCallback(
    (presetId: string) => {
      setCustomPresets((prev) => {
        const next = prev.filter((p) => p.id !== presetId);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // ignore storage errors
        }
        return next;
      });
      if (activePresetId === presetId) {
        setActivePresetId(null);
      }
    },
    [activePresetId]
  );

  const getFilterState = useCallback((): FilterState | null => {
    if (!activePreset) return null;
    return {
      ...activePreset.filter,
      gateTypes: new Set(activePreset.filter.gateTypes),
    };
  }, [activePreset]);

  return {
    presets: allPresets,
    activePresetId,
    activePreset,
    selectPreset,
    saveCustomPreset,
    deleteCustomPreset,
    getFilterState,
  };
}
