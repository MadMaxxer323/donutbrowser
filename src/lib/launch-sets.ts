/**
 * Saved bulk-launch selections. These contain only local profile ids and an
 * optional starting URL; they never copy profile data, cookies, or secrets.
 */

export const SAVED_LAUNCH_SETS_KEY = "hiderthbrowser.saved-launch-sets.v1";
export const SAVED_LAUNCH_SET_LIMIT = 40;
export const LAUNCH_SET_PROFILE_LIMIT = 2_000;
export const LAUNCH_SET_NAME_LIMIT = 60;
const MAX_START_URL_LENGTH = 2_048;
const MAX_STORED_LENGTH = 2_000_000;

export interface SavedLaunchSet {
  id: string;
  name: string;
  profileIds: string[];
  startUrl: string | null;
  updatedAt: number;
}

export interface SaveLaunchSetInput {
  name: string;
  profileIds: string[];
  startUrl?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An empty value means each profile uses its own saved startup pages. */
export function normalizeStartingUrl(value: string): string | undefined | null {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_START_URL_LENGTH) return null;

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function checkedProfileIds(profileIds: unknown): string[] | null {
  if (
    !Array.isArray(profileIds) ||
    profileIds.length === 0 ||
    profileIds.length > LAUNCH_SET_PROFILE_LIMIT
  ) {
    return null;
  }

  const checked = new Set<string>();
  for (const value of profileIds) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      return null;
    }
    checked.add(value);
  }
  return [...checked];
}

function checkedLaunchSet(value: unknown): SavedLaunchSet | null {
  if (!isRecord(value)) return null;
  const { id, name, profileIds, startUrl, updatedAt } = value;
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(id) ||
    typeof name !== "string" ||
    typeof updatedAt !== "number" ||
    !Number.isFinite(updatedAt)
  ) {
    return null;
  }

  const checkedName = name.trim();
  const checkedIds = checkedProfileIds(profileIds);
  if (
    !checkedName ||
    checkedName.length > LAUNCH_SET_NAME_LIMIT ||
    !checkedIds
  ) {
    return null;
  }

  let checkedUrl: string | undefined;
  if (startUrl !== null && startUrl !== undefined) {
    if (typeof startUrl !== "string") return null;
    const normalizedUrl = normalizeStartingUrl(startUrl);
    if (!normalizedUrl) return null;
    checkedUrl = normalizedUrl;
  }

  return {
    id,
    name: checkedName,
    profileIds: checkedIds,
    startUrl: checkedUrl ?? null,
    updatedAt,
  };
}

export function parseSavedLaunchSets(raw: string | null): SavedLaunchSet[] {
  if (!raw || raw.length > MAX_STORED_LENGTH) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .map(checkedLaunchSet)
      .filter((item): item is SavedLaunchSet => item !== null)
      .slice(0, SAVED_LAUNCH_SET_LIMIT)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function upsertSavedLaunchSet(
  current: SavedLaunchSet[],
  input: SaveLaunchSetInput,
  updatedAt = Date.now(),
  idFactory: () => string = createId,
): SavedLaunchSet[] {
  const name = input.name.trim();
  if (!name || name.length > LAUNCH_SET_NAME_LIMIT) {
    throw new Error(
      `Enter a name of 1 to ${LAUNCH_SET_NAME_LIMIT} characters.`,
    );
  }

  const profileIds = checkedProfileIds(input.profileIds);
  if (!profileIds) {
    throw new Error(
      `Select between 1 and ${LAUNCH_SET_PROFILE_LIMIT} profiles.`,
    );
  }

  let startUrl: string | undefined;
  if (input.startUrl?.trim()) {
    const normalizedUrl = normalizeStartingUrl(input.startUrl);
    if (!normalizedUrl) {
      throw new Error("Enter a valid HTTP or HTTPS starting URL.");
    }
    startUrl = normalizedUrl;
  }

  const existing = current.find(
    (item) =>
      item.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0,
  );
  if (!existing && current.length >= SAVED_LAUNCH_SET_LIMIT) {
    throw new Error(
      `You can save up to ${SAVED_LAUNCH_SET_LIMIT} launch sets.`,
    );
  }

  const next: SavedLaunchSet = {
    id: existing?.id ?? idFactory(),
    name,
    profileIds,
    startUrl: startUrl ?? null,
    updatedAt,
  };
  return [next, ...current.filter((item) => item.id !== next.id)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

export function removeSavedLaunchSet(
  current: SavedLaunchSet[],
  id: string,
): SavedLaunchSet[] {
  return current.filter((item) => item.id !== id);
}

function getStorage(): Storage {
  if (typeof window === "undefined") {
    throw new Error("Saved launch sets are available in the desktop app.");
  }
  try {
    return window.localStorage;
  } catch {
    throw new Error("Local storage is unavailable for saved launch sets.");
  }
}

export function listSavedLaunchSets(): SavedLaunchSet[] {
  const storage = getStorage();
  return parseSavedLaunchSets(storage.getItem(SAVED_LAUNCH_SETS_KEY));
}

export function saveSavedLaunchSet(
  name: string,
  profileIds: string[],
  startUrl?: string,
): SavedLaunchSet[] {
  const storage = getStorage();
  const current = parseSavedLaunchSets(storage.getItem(SAVED_LAUNCH_SETS_KEY));
  const next = upsertSavedLaunchSet(current, { name, profileIds, startUrl });
  storage.setItem(SAVED_LAUNCH_SETS_KEY, JSON.stringify(next));
  return next;
}

export function deleteSavedLaunchSet(id: string): SavedLaunchSet[] {
  const storage = getStorage();
  const next = removeSavedLaunchSet(
    parseSavedLaunchSets(storage.getItem(SAVED_LAUNCH_SETS_KEY)),
    id,
  );
  storage.setItem(SAVED_LAUNCH_SETS_KEY, JSON.stringify(next));
  return next;
}

/** Portable file format for saved launch sets. Profile IDs are local references. */
export const SAVED_LAUNCH_SET_EXPORT_FORMAT = "hiderthbrowser.launch-sets";
export const SAVED_LAUNCH_SET_EXPORT_VERSION = 1;

export function serializeSavedLaunchSets(
  sets: SavedLaunchSet[],
  exportedAt = new Date().toISOString(),
): string {
  if (!Array.isArray(sets) || sets.length === 0) {
    throw new Error("There are no saved launch sets to export.");
  }
  if (sets.length > SAVED_LAUNCH_SET_LIMIT) {
    throw new Error(`You can export up to ${SAVED_LAUNCH_SET_LIMIT} launch sets.`);
  }

  const checked = sets
    .map(checkedLaunchSet)
    .filter((item): item is SavedLaunchSet => item !== null);
  if (checked.length !== sets.length) {
    throw new Error(
      "Saved launch set data is invalid. Review the saved sets and try again.",
    );
  }

  const content = JSON.stringify(
    {
      format: SAVED_LAUNCH_SET_EXPORT_FORMAT,
      version: SAVED_LAUNCH_SET_EXPORT_VERSION,
      exportedAt,
      launchSets: checked.map((item) => ({
        name: item.name,
        profileIds: item.profileIds,
        startUrl: item.startUrl,
      })),
    },
    null,
    2,
  );
  if (content.length > MAX_STORED_LENGTH) {
    throw new Error("The export is too large.");
  }
  return `${content}\n`;
}

/**
 * Parse the complete portable file before changing local storage. One invalid
 * entry rejects the whole import, so a partly imported file is never mistaken
 * for a complete backup.
 */
export function parseLaunchSetExport(raw: string): SaveLaunchSetInput[] {
  if (!raw || raw.length > MAX_STORED_LENGTH) {
    throw new Error("The launch set file is empty or too large.");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The launch set file is not valid JSON.");
  }

  if (
    !isRecord(value) ||
    value.format !== SAVED_LAUNCH_SET_EXPORT_FORMAT ||
    value.version !== SAVED_LAUNCH_SET_EXPORT_VERSION
  ) {
    throw new Error("This is not a supported HiderTHBROWser launch set file.");
  }
  if (
    !Array.isArray(value.launchSets) ||
    value.launchSets.length === 0 ||
    value.launchSets.length > SAVED_LAUNCH_SET_LIMIT
  ) {
    throw new Error(
      `The file must contain between 1 and ${SAVED_LAUNCH_SET_LIMIT} launch sets.`,
    );
  }

  const names = new Set<string>();
  const imported: SaveLaunchSetInput[] = [];
  for (const entry of value.launchSets) {
    if (!isRecord(entry)) {
      throw new Error("The launch set file contains an invalid entry.");
    }
    const checked = checkedLaunchSet({
      id: "imported",
      name: entry.name,
      profileIds: entry.profileIds,
      startUrl: entry.startUrl ?? null,
      updatedAt: 0,
    });
    if (!checked) {
      throw new Error(
        "The launch set file contains invalid names, profile IDs, or URLs.",
      );
    }
    const nameKey = checked.name.toLocaleLowerCase();
    if (names.has(nameKey)) {
      throw new Error("The launch set file contains duplicate names.");
    }
    names.add(nameKey);
    imported.push({
      name: checked.name,
      profileIds: checked.profileIds,
      startUrl: checked.startUrl,
    });
  }
  return imported;
}

/** Merge imported sets by name; a same-name import updates the existing set. */
export function mergeImportedLaunchSets(
  current: SavedLaunchSet[],
  imported: SaveLaunchSetInput[],
  updatedAt = Date.now(),
  idFactory: () => string = createId,
): SavedLaunchSet[] {
  if (
    !Array.isArray(imported) ||
    imported.length === 0 ||
    imported.length > SAVED_LAUNCH_SET_LIMIT
  ) {
    throw new Error("The imported launch set list is invalid.");
  }

  let next = current;
  for (let index = 0; index < imported.length; index += 1) {
    next = upsertSavedLaunchSet(
      next,
      imported[index],
      updatedAt + index,
      idFactory,
    );
  }
  return next;
}

/** Replace local saved-set storage after a validated, atomic import merge. */
export function storeSavedLaunchSets(
  sets: SavedLaunchSet[],
): SavedLaunchSet[] {
  if (!Array.isArray(sets) || sets.length > SAVED_LAUNCH_SET_LIMIT) {
    throw new Error("The saved launch set list is invalid.");
  }
  const checked = sets
    .map(checkedLaunchSet)
    .filter((item): item is SavedLaunchSet => item !== null);
  if (checked.length !== sets.length) {
    throw new Error("The saved launch set list contains invalid data.");
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of checked) {
    const nameKey = item.name.toLocaleLowerCase();
    if (ids.has(item.id) || names.has(nameKey)) {
      throw new Error(
        "The saved launch set list contains duplicate IDs or names.",
      );
    }
    ids.add(item.id);
    names.add(nameKey);
  }
  const next = checked.sort((a, b) => b.updatedAt - a.updatedAt);
  getStorage().setItem(SAVED_LAUNCH_SETS_KEY, JSON.stringify(next));
  return next;
}
