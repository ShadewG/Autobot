"use client";

import { useState, useCallback, useEffect } from "react";

export function useSelection(validIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Auto-clear stale IDs when data refreshes
  useEffect(() => {
    const validSet = new Set(validIds);
    setSelected((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (validSet.has(id)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [validIds]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback((ids: string[]) => {
    setSelected((prev) => {
      const allSelected = ids.every((id) => prev.has(id));
      if (allSelected) {
        // Deselect all
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      } else {
        // Select all
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      }
    });
  }, []);

  const deselectAll = useCallback(() => {
    setSelected(new Set());
  }, []);

  const isSelected = useCallback(
    (id: string) => selected.has(id),
    [selected]
  );

  return {
    selected,
    toggle,
    toggleAll,
    deselectAll,
    isSelected,
    count: selected.size,
  };
}
