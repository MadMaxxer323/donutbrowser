"use client";

import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
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
import {
  deleteSavedLaunchSet,
  listSavedLaunchSets,
  mergeImportedLaunchSets,
  normalizeStartingUrl,
  parseLaunchSetExport,
  type SavedLaunchSet,
  saveSavedLaunchSet,
  serializeSavedLaunchSets,
  storeSavedLaunchSets,
} from "@/lib/launch-sets";

interface BatchLaunchDialogProps {
  isOpen: boolean;
  profileCount: number;
  profileIds: string[];
  onClose: () => void;
  onLaunch: (url?: string) => void;
  onApplySet: (profileIds: string[]) => {
    availableCount: number;
    skippedCount: number;
  };
}

/**
 * Starts selected isolated profiles together on one optional URL. Saved sets
 * remember profile ids and that URL locally; the existing launch queue still
 * controls concurrency, pacing, progress and cancellation.
 */
export function BatchLaunchDialog({
  isOpen,
  profileCount,
  profileIds,
  onClose,
  onLaunch,
  onApplySet,
}: BatchLaunchDialogProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [setName, setSetName] = useState("");
  const [savedSets, setSavedSets] = useState<SavedLaunchSet[]>([]);
  const [setErrorMessage, setSetError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setUrl("");
    setError(null);
    setSetName("");
    setSetError(null);
    setNotice(null);
    try {
      setSavedSets(listSavedLaunchSets());
    } catch (loadError) {
      setSavedSets([]);
      setSetError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load saved launch sets.",
      );
    }
  }, [isOpen]);

  const submit = () => {
    const normalized = normalizeStartingUrl(url);
    if (normalized === null) {
      setError("Enter a valid HTTP or HTTPS address without credentials.");
      return;
    }
    onLaunch(normalized);
  };

  const saveCurrentSet = () => {
    if (profileIds.length === 0) return;
    const normalized = normalizeStartingUrl(url);
    if (normalized === null) {
      setError("Enter a valid HTTP or HTTPS address without credentials.");
      return;
    }
    try {
      const next = saveSavedLaunchSet(setName, profileIds, normalized);
      setSavedSets(next);
      setSetName("");
      setSetError(null);
      setNotice("Launch set saved on this device.");
    } catch (saveError) {
      setSetError(
        saveError instanceof Error
          ? saveError.message
          : "Could not save this launch set.",
      );
    }
  };

  const exportLaunchSets = async () => {
    if (savedSets.length === 0) return;
    setIsTransferringSets(true);
    try {
      const destination = await save({
        title: "Export saved launch sets",
        defaultPath: "HiderTHBROWser-launch-sets.hiderlaunchsets",
        filters: [
          {
            name: "HiderTHBROWser launch sets",
            extensions: ["hiderlaunchsets"],
          },
        ],
      });
      if (!destination) return;
      await writeTextFile(destination, serializeSavedLaunchSets(savedSets));
      setSetError(null);
      setNotice(`${savedSets.length} launch sets exported.`);
    } catch (exportError) {
      setSetError(
        exportError instanceof Error
          ? exportError.message
          : "Could not export saved launch sets.",
      );
    } finally {
      setIsTransferringSets(false);
    }
  };

  const importLaunchSets = async () => {
    setIsTransferringSets(true);
    try {
      const selected = await openDialog({
        multiple: false,
        title: "Import saved launch sets",
        filters: [
          {
            name: "HiderTHBROWser launch sets",
            extensions: ["hiderlaunchsets"],
          },
        ],
      });
      if (typeof selected !== "string") return;
      const imported = parseLaunchSetExport(await readTextFile(selected));
      const merged = mergeImportedLaunchSets(savedSets, imported);
      const next = storeSavedLaunchSets(merged);
      setSavedSets(next);
      setSetError(null);
      setNotice(
        `${imported.length} launch sets imported. Matching names were updated; unavailable profiles are skipped when a set is used.`,
      );
    } catch (importError) {
      setSetError(
        importError instanceof Error
          ? importError.message
          : "Could not import saved launch sets.",
      );
    } finally {
      setIsTransferringSets(false);
    }
  };

  const applySet = (savedSet: SavedLaunchSet) => {
    const result = onApplySet(savedSet.profileIds);
    setUrl(savedSet.startUrl ?? "");
    setError(null);
    setNotice(
      result.skippedCount > 0
        ? `${result.availableCount} profiles ready; ${result.skippedCount} missing or already running profiles skipped.`
        : `${result.availableCount} profiles selected from “${savedSet.name}”.`,
    );
  };

  const removeSet = (id: string) => {
    try {
      setSavedSets(deleteSavedLaunchSet(id));
      setSetError(null);
      setNotice("Saved launch set deleted.");
    } catch (deleteError) {
      setSetError(
        deleteError instanceof Error
          ? deleteError.message
          : "Could not delete this launch set.",
      );
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
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
              setNotice(null);
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

        <section className="space-y-3 rounded-xl border border-border/70 p-3">
          <div>
            <h3 className="text-sm font-medium">Save this launch set</h3>
            <p className="text-xs text-muted-foreground">
              Remember the selected profiles and shared URL on this device.
              Profile data and secrets are not copied.
            </p>
          </div>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Label htmlFor="batch-launch-set-name" className="sr-only">
                Launch set name
              </Label>
              <Input
                id="batch-launch-set-name"
                value={setName}
                maxLength={60}
                placeholder="Name this set"
                onChange={(event) => {
                  setSetName(event.target.value);
                  setSetError(null);
                }}
              />
            </div>
            <Button
              variant="outline"
              onClick={saveCurrentSet}
              disabled={profileIds.length === 0 || !setName.trim()}
            >
              Save set
            </Button>
          </div>
          {setErrorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {setErrorMessage}
            </p>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Saved launch sets</h3>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                {savedSets.length} saved
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={isTransferringSets}
                onClick={() => void importLaunchSets()}
              >
                Import
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={isTransferringSets || savedSets.length === 0}
                onClick={() => void exportLaunchSets()}
              >
                Export
              </Button>
            </div>
          </div>
          {savedSets.length === 0 ? (
            <p className="rounded-lg bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">
              No saved launch sets yet.
            </p>
          ) : (
            <div className="max-h-44 space-y-1 overflow-y-auto">
              {savedSets.map((savedSet) => (
                <div
                  key={savedSet.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {savedSet.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {savedSet.profileIds.length} profiles
                      {savedSet.startUrl ? ` · ${savedSet.startUrl}` : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => applySet(savedSet)}
                  >
                    Use
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete ${savedSet.name}`}
                    onClick={() => removeSet(savedSet.id)}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>

        {notice && (
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {notice}
          </p>
        )}

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
