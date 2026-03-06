"use client";

import React from "react";
import { sanitizeDisplayUrl } from "@/lib/utils";
import { cn } from "@/lib/utils";

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"\])}]+)([.,!?;:]?)/gi;

function normalizeHref(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

interface LinkifiedTextProps {
  text: string;
  className?: string;
}

export function LinkifiedText({ text, className }: LinkifiedTextProps) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_RE)) {
    const full = match[0];
    const url = match[1] || full;
    const trailing = match[2] || "";
    const index = match.index ?? 0;

    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index));
    }

    const { label, isTracked } = sanitizeDisplayUrl(url);
    parts.push(
      <a
        key={`${index}-${url}`}
        href={normalizeHref(url)}
        target="_blank"
        rel="noopener noreferrer"
        className={cn("hover:underline break-all", isTracked ? "text-muted-foreground" : "text-blue-400")}
        title={url}
      >
        {label}
      </a>
    );

    if (trailing) {
      parts.push(trailing);
    }

    lastIndex = index + full.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <span className={className}>{parts}</span>;
}
