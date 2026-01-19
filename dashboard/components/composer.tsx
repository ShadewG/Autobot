"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Sparkles, Send, Loader2 } from "lucide-react";

interface ComposerProps {
  onSend: (content: string) => Promise<void>;
  onGenerateDraft?: () => Promise<string>;
  disabled?: boolean;
}

export function Composer({ onSend, onGenerateDraft, disabled }: ComposerProps) {
  const [content, setContent] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleSend = async () => {
    if (!content.trim()) return;
    setIsSending(true);
    try {
      await onSend(content);
      setContent("");
    } finally {
      setIsSending(false);
    }
  };

  const handleGenerateDraft = async () => {
    if (!onGenerateDraft) return;
    setIsGenerating(true);
    try {
      const draft = await onGenerateDraft();
      setContent(draft);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-3">
      <Separator />
      <div className="flex items-center gap-2">
        {onGenerateDraft && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerateDraft}
            disabled={disabled || isGenerating}
          >
            {isGenerating ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Sparkles className="h-4 w-4 mr-1" />
            )}
            Generate Draft
          </Button>
        )}
      </div>
      <Textarea
        placeholder="Write your message..."
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={disabled}
        rows={4}
      />
      <div className="flex justify-end">
        <Button
          onClick={handleSend}
          disabled={disabled || isSending || !content.trim()}
        >
          {isSending ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            <Send className="h-4 w-4 mr-1" />
          )}
          Send
        </Button>
      </div>
    </div>
  );
}
