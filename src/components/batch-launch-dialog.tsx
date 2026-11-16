"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface BatchLaunchDialogProps {
  isOpen: boolean;
  profileCount: number;
  onClose: () => void;
  onLaunch: (url?: string) => void;
}

/** Validate a shared starting URL without requiring users to type a scheme. */
function normalizeStartingUrl(value: string): string | undefined | null {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Starts the selected, isolated profiles together on one optional URL.
 * The existing bulk-launch queue still controls concurrency and start delay.
 */
export function BatchLaunchDialog({
  isOpen,
  profileCount,
  onClose,
  onLaunch,
}: BatchLaunchDialogProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setUrl("");
      setError(null);
    }
  }, [isOpen]);

  const submit = () => {
    const normalized = normalizeStartingUrl(url);
    if (normalized === null) {
      setError("Enter a valid HTTP or HTTPS address.");
      return;
    }
    onLaunch(normalized);
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Launch selected profiles</DialogTitle>
          <DialogDescription>
            Launch {profileCount} separate browser profiles. An optional URL
            will open in every profile; leave it blank to use each profile's
            saved startup pages.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="batch-launch-url">
            Shared starting URL (optional)
          </Label>
          <Input
            id="batch-launch-url"
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder="https://example.com"
            value={url}
            aria-invalid={error !== null}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Each profile keeps its own cookies, storage, and browser session.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={profileCount === 0}>
            Launch {profileCount} profiles
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
