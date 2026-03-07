"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Paperclip, X } from "lucide-react";

export interface Attachment {
  filename: string;
  content: string; // base64
  type: string;    // MIME type
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 5;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix (e.g. "data:application/pdf;base64,")
      resolve(result.split(",")[1]);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface AttachmentPickerProps {
  attachments: Attachment[];
  onChange: (attachments: Attachment[]) => void;
  disabled?: boolean;
}

export function AttachmentPicker({ attachments, onChange, disabled }: AttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const remaining = MAX_FILES - attachments.length;
    if (remaining <= 0) return;

    const toAdd = Array.from(files).slice(0, remaining);
    const newAttachments: Attachment[] = [];

    for (const file of toAdd) {
      if (file.size > MAX_FILE_SIZE) {
        alert(`"${file.name}" exceeds the 10MB limit and was skipped.`);
        continue;
      }
      const content = await readFileAsBase64(file);
      newAttachments.push({
        filename: file.name,
        content,
        type: file.type || "application/octet-stream",
      });
    }

    if (newAttachments.length > 0) {
      onChange([...attachments, ...newAttachments]);
    }

    // Reset input so the same file can be re-selected
    if (inputRef.current) inputRef.current.value = "";
  };

  const removeAttachment = (index: number) => {
    onChange(attachments.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
        disabled={disabled}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || attachments.length >= MAX_FILES}
        className="gap-1"
      >
        <Paperclip className="h-4 w-4" />
        Attach {attachments.length > 0 ? `(${attachments.length}/${MAX_FILES})` : ""}
      </Button>

      {attachments.length > 0 && (
        <ul className="space-y-1">
          {attachments.map((att, i) => (
            <li key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
              <Paperclip className="h-3 w-3 shrink-0" />
              <span className="truncate max-w-[200px]">{att.filename}</span>
              <span className="shrink-0">
                ({formatSize(Math.ceil((att.content.length * 3) / 4))})
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                className="text-destructive hover:text-destructive/80"
                disabled={disabled}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
