"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Sparkles, Send, Loader2 } from "lucide-react";
import { AttachmentPicker, type Attachment } from "@/components/attachment-picker";

interface ComposerProps {
  onSend: (content: string, attachments?: Attachment[]) => Promise<void>;
  onGenerateDraft?: () => Promise<string>;
  disabled?: boolean;
  extraActions?: React.ReactNode;
}

export function Composer({ onSend, onGenerateDraft, disabled, extraActions }: ComposerProps) {
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleSend = async () => {
    if (!content.trim()) return;
    setIsSending(true);
    try {
      await onSend(content, attachments.length > 0 ? attachments : undefined);
      setContent("");
      setAttachments([]);
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
      <AttachmentPicker
        attachments={attachments}
        onChange={setAttachments}
        disabled={disabled || isSending}
      />
      <div className="flex justify-end gap-2">
        {extraActions}
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
