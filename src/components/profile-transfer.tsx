"use client";

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuDownload, LuShieldCheck } from "react-icons/lu";
import { LoadingButton } from "@/components/loading-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { translateBackendError } from "@/lib/backend-errors";
import { showToast } from "@/lib/toast-utils";
import type { BrowserProfile } from "@/types";

/** The file extension a Donut profile archive carries. */
export const PROFILE_ARCHIVE_EXTENSION = "donutprofile";

interface PortableManifest {
  format_version: number;
  exported_by: string;
  exported_at: number;
  profile_name: string;
  browser: string;
  version: string;
  includes_data: boolean;
  data_omitted_reason?: string;
}

/**
 * Write this profile to a file another machine can read.
 *
 * The data is opt-in rather than assumed: a configuration-only archive is
 * small enough to send, while one carrying cookies and logins is the profile
 * itself and should be moved deliberately.
 */
export function ExportProfileSection({
  profile,
  isRunning = Boolean(profile.process_id),
}: {
  profile: BrowserProfile;
  /** The live state when the caller knows it; the stored pid otherwise. */
  isRunning?: boolean;
}) {
  const { t } = useTranslation();
  const includeDataId = useId();
  const [includeData, setIncludeData] = useState(true);
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    const destination = await save({
      title: t("profileTransfer.exportTitle"),
      defaultPath: `${profile.name}.${PROFILE_ARCHIVE_EXTENSION}`,
      filters: [
        {
          name: t("profileTransfer.archiveFilter"),
          extensions: [PROFILE_ARCHIVE_EXTENSION],
        },
      ],
    });
    if (!destination) return;

    setIsExporting(true);
    try {
      const manifest = await invoke<PortableManifest>("export_profile", {
        profileId: profile.id,
        destination,
        includeData: includeData && !profile.password_protected,
      });
      if (manifest.includes_data) {
        showToast({
          type: "success",
          title: t("profileTransfer.exportedWithData"),
        });
      } else {
        showToast({
          type: "success",
          title: t("profileTransfer.exportedConfigOnly"),
        });
      }
    } catch (error) {
      showToast({
        type: "error",
        title: translateBackendError(t, error),
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {t("profileTransfer.exportDescription")}
      </p>
      <div className="flex items-center gap-x-2">
        <Checkbox
          id={includeDataId}
          checked={includeData && !profile.password_protected}
          disabled={profile.password_protected || isExporting}
          onCheckedChange={(checked) => {
            setIncludeData(checked === true);
          }}
        />
        <Label htmlFor={includeDataId}>
          {t("profileTransfer.includeData")}
        </Label>
      </div>
      {profile.password_protected && (
        <p className="text-xs text-muted-foreground">
          {t("profileTransfer.protectedNotice")}
        </p>
      )}
      {isRunning && (
        <p className="text-xs text-warning-text">
          {t("profileTransfer.runningNotice")}
        </p>
      )}
      <LoadingButton
        variant="soft"
        size="sm"
        className="h-8 gap-1.5 self-start rounded-lg px-2.5 text-xs"
        isLoading={isExporting}
        disabled={isRunning}
        onClick={() => {
          void handleExport();
        }}
      >
        <LuDownload className="size-3.5" />
        {t("profileTransfer.exportButton")}
      </LoadingButton>
    </div>
  );
}

interface EncryptedBackupSummary {
  profileName: string;
  files: number;
  bytes: number;
  restoredProfileId: string | null;
  networkSettingsRestored: boolean;
}

function encryptedBackupErrorTitle(
  t: Parameters<typeof translateBackendError>[0],
  error: unknown,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("LOCAL_BACKUP_PROFILE_UNLOCKED")) {
    return t("profileTransfer.encryptedBackupLockFirst");
  }
  if (raw.includes("LOCAL_BACKUP_PROFILE_RUNNING")) {
    return t("profileTransfer.encryptedBackupCloseBrowser");
  }
  if (raw.includes("LOCAL_BACKUP_PASSWORD_TOO_SHORT")) {
    return t("profileTransfer.encryptedBackupTooShort");
  }
  if (raw.includes("LOCAL_BACKUP_PASSWORD_OR_DATA_INVALID")) {
    return t("profileTransfer.encryptedRestoreWrongPassword");
  }
  if (
    raw.includes("LOCAL_BACKUP_INVALID_ARCHIVE") ||
    raw.includes("LOCAL_BACKUP_INTEGRITY_FAILED") ||
    raw.includes("LOCAL_BACKUP_VERSION_OR_LIMIT_UNSUPPORTED")
  ) {
    return t("profileTransfer.encryptedRestoreInvalidArchive");
  }
  return translateBackendError(t, error);
}

/**
 * Passphrase-encrypted full profile snapshot. Restore always creates a new
 * profile and deliberately clears machine-specific network references.
 */
export function EncryptedProfileBackupSection({
  profile,
  isRunning = Boolean(profile.process_id),
}: {
  profile: BrowserProfile;
  isRunning?: boolean;
}) {
  const { t } = useTranslation();
  const backupPasswordId = useId();
  const backupConfirmId = useId();
  const restorePasswordId = useId();
  const [backupPassword, setBackupPassword] = useState("");
  const [backupConfirm, setBackupConfirm] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [restorePath, setRestorePath] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isChoosing, setIsChoosing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  const canCreate = !isRunning && !profile.ephemeral && !profile.temporary;

  const handleCreateBackup = async () => {
    if (backupPassword.length < 12) {
      showToast({
        type: "error",
        title: t("profileTransfer.encryptedBackupTooShort"),
      });
      return;
    }
    if (backupPassword !== backupConfirm) {
      showToast({
        type: "error",
        title: t("profileTransfer.encryptedBackupMismatch"),
      });
      return;
    }

    if (profile.password_protected) {
      try {
        const locked = await invoke<boolean>("is_profile_locked", {
          profileId: profile.id,
        });
        if (!locked) {
          showToast({
            type: "error",
            title: t("profileTransfer.encryptedBackupLockFirst"),
          });
          return;
        }
      } catch (error) {
        showToast({
          type: "error",
          title: encryptedBackupErrorTitle(t, error),
        });
        return;
      }
    }

    const destination = await save({
      title: t("profileTransfer.encryptedBackupTitle"),
      defaultPath: `${profile.name}.hiderbackup`,
      filters: [
        {
          name: t("profileTransfer.encryptedRestoreFileType"),
          extensions: ["hiderbackup"],
        },
      ],
    });
    if (!destination) return;

    setIsCreating(true);
    try {
      const result = await invoke<EncryptedBackupSummary>(
        "create_local_profile_backup",
        {
          profileId: profile.id,
          destination,
          password: backupPassword,
        },
      );
      showToast({
        type: "success",
        title: t("profileTransfer.encryptedBackupCreated", {
          name: result.profileName,
        }),
      });
      setBackupPassword("");
      setBackupConfirm("");
    } catch (error) {
      showToast({
        type: "error",
        title: encryptedBackupErrorTitle(t, error),
      });
    } finally {
      setIsCreating(false);
    }
  };

  const handleChooseRestore = async () => {
    setIsChoosing(true);
    try {
      const selected = await open({
        multiple: false,
        title: t("profileTransfer.encryptedRestoreTitle"),
        filters: [
          {
            name: t("profileTransfer.encryptedRestoreFileType"),
            extensions: ["hiderbackup"],
          },
        ],
      });
      if (typeof selected === "string") {
        setRestorePath(selected);
        setRestorePassword("");
      }
    } catch (error) {
      showToast({
        type: "error",
        title: encryptedBackupErrorTitle(t, error),
      });
    } finally {
      setIsChoosing(false);
    }
  };

  const handleRestore = async () => {
    if (!restorePath) return;
    if (restorePassword.length < 12) {
      showToast({
        type: "error",
        title: t("profileTransfer.encryptedBackupTooShort"),
      });
      return;
    }

    setIsRestoring(true);
    try {
      const result = await invoke<EncryptedBackupSummary>(
        "restore_local_profile_backup",
        {
          source: restorePath,
          password: restorePassword,
        },
      );
      showToast({
        type: "success",
        title: t("profileTransfer.encryptedRestoreSuccess", {
          name: result.profileName,
        }),
      });
      setRestorePath(null);
      setRestorePassword("");
    } catch (error) {
      showToast({
        type: "error",
        title: encryptedBackupErrorTitle(t, error),
      });
    } finally {
      setIsRestoring(false);
    }
  };

  const selectedFileName = restorePath?.split(/[\\/]/).pop();

  return (
    <div className="flex flex-col gap-5 border-t pt-4">
      <div className="flex items-center gap-2">
        <LuShieldCheck className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">
          {t("profileTransfer.encryptedBackupTitle")}
        </h3>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("profileTransfer.encryptedBackupDescription")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("profileTransfer.encryptedBackupNoRecovery")}
      </p>
      <div className="flex flex-col gap-2">
        <label htmlFor={backupPasswordId} className="text-xs font-medium">
          {t("profileTransfer.encryptedBackupPassword")}
        </label>
        <Input
          id={backupPasswordId}
          type="password"
          autoComplete="new-password"
          value={backupPassword}
          disabled={!canCreate || isCreating}
          onChange={(event) => setBackupPassword(event.target.value)}
        />
        <label htmlFor={backupConfirmId} className="text-xs font-medium">
          {t("profileTransfer.encryptedBackupConfirmPassword")}
        </label>
        <Input
          id={backupConfirmId}
          type="password"
          autoComplete="new-password"
          value={backupConfirm}
          disabled={!canCreate || isCreating}
          onChange={(event) => setBackupConfirm(event.target.value)}
        />
        {isRunning && (
          <p className="text-xs text-warning-text">
            {t("profileTransfer.encryptedBackupCloseBrowser")}
          </p>
        )}
        <LoadingButton
          variant="soft"
          size="sm"
          className="h-8 self-start rounded-lg px-2.5 text-xs"
          isLoading={isCreating}
          disabled={!canCreate || !backupPassword || !backupConfirm}
          onClick={() => void handleCreateBackup()}
        >
          {t("profileTransfer.encryptedBackupButton")}
        </LoadingButton>
      </div>

      <div className="flex flex-col gap-2 border-t pt-4">
        <h3 className="text-sm font-medium">
          {t("profileTransfer.encryptedRestoreTitle")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("profileTransfer.encryptedRestoreDescription")}
        </p>
        <LoadingButton
          variant="outline"
          size="sm"
          className="self-start"
          isLoading={isChoosing}
          onClick={() => void handleChooseRestore()}
        >
          {t("profileTransfer.encryptedRestoreChoose")}
        </LoadingButton>
        {restorePath && (
          <>
            <p className="text-xs text-muted-foreground">{selectedFileName}</p>
            <label htmlFor={restorePasswordId} className="text-xs font-medium">
              {t("profileTransfer.encryptedRestorePassword")}
            </label>
            <Input
              id={restorePasswordId}
              type="password"
              autoComplete="current-password"
              value={restorePassword}
              disabled={isRestoring}
              onChange={(event) => setRestorePassword(event.target.value)}
            />
            <LoadingButton
              size="sm"
              className="self-start"
              isLoading={isRestoring}
              disabled={!restorePassword}
              onClick={() => void handleRestore()}
            >
              {t("profileTransfer.encryptedRestoreButton")}
            </LoadingButton>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Read a Donut archive back as a new profile.
 *
 * The archive is inspected before anything is created, so the user sees what
 * they are about to add: its name, its browser version, and whether it carries
 * the browser data or only the configuration.
 */
export function ImportProfileArchive({
  onImported,
}: {
  onImported?: (profile: BrowserProfile) => void;
}) {
  const { t } = useTranslation();
  const [archive, setArchive] = useState<string | null>(null);
  const [manifest, setManifest] = useState<PortableManifest | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const handleChoose = async () => {
    const selected = await open({
      multiple: false,
      title: t("profileTransfer.importTitle"),
      filters: [
        {
          name: t("profileTransfer.archiveFilter"),
          extensions: [PROFILE_ARCHIVE_EXTENSION],
        },
      ],
    });
    if (typeof selected !== "string") return;

    setIsBusy(true);
    try {
      const preview = await invoke<{ manifest: PortableManifest }>(
        "preview_profile_archive",
        { path: selected },
      );
      setArchive(selected);
      setManifest(preview.manifest);
    } catch (error) {
      setArchive(null);
      setManifest(null);
      showToast({ type: "error", title: translateBackendError(t, error) });
    } finally {
      setIsBusy(false);
    }
  };

  const handleImport = async () => {
    if (!archive) return;
    setIsBusy(true);
    try {
      const profile = await invoke<BrowserProfile>("import_profile_archive", {
        path: archive,
      });
      showToast({
        type: "success",
        title: t("profileTransfer.imported", { name: profile.name }),
      });
      setArchive(null);
      setManifest(null);
      onImported?.(profile);
    } catch (error) {
      showToast({ type: "error", title: translateBackendError(t, error) });
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("profileTransfer.importDescription")}
      </p>
      <LoadingButton
        isLoading={isBusy && !manifest}
        variant="outline"
        onClick={() => {
          void handleChoose();
        }}
      >
        {t("profileTransfer.chooseArchive")}
      </LoadingButton>

      {manifest && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="space-y-1 text-sm">
            <p className="font-medium">{manifest.profile_name}</p>
            <p className="text-muted-foreground">
              {t("profileTransfer.archiveVersion", {
                browser: manifest.browser,
                version: manifest.version,
              })}
            </p>
            <p className="text-muted-foreground">
              {manifest.includes_data
                ? t("profileTransfer.archiveWithData")
                : t("profileTransfer.archiveConfigOnly")}
            </p>
          </div>
          <LoadingButton
            isLoading={isBusy}
            onClick={() => {
              void handleImport();
            }}
          >
            {t("profileTransfer.importButton")}
          </LoadingButton>
        </div>
      )}
    </div>
  );
}
