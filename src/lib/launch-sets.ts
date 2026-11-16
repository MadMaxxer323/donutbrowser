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
export function normalizeStartingUrl(
  value: string,
): string | undefined | null {
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
    !Number.isFinite(updatedAt) ||
    typeof updatedAt !== "number"
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
    checkedUrl = normalizeStartingUrl(startUrl);
    if (!checkedUrl) return null;
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
    throw new Error(`Enter a name of 1 to ${LAUNCH_SET_NAME_LIMIT} characters.`);
  }

  const profileIds = checkedProfileIds(input.profileIds);
  if (!profileIds) {
    throw new Error(
      `Select between 1 and ${LAUNCH_SET_PROFILE_LIMIT} profiles.`,
    );
  }

  let startUrl: string | undefined;
  if (input.startUrl?.trim()) {
    startUrl = normalizeStartingUrl(input.startUrl);
    if (!startUrl) {
      throw new Error("Enter a valid HTTP or HTTPS starting URL.");
    }
  }

  const existing = current.find(
    (item) => item.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0,
  );
  if (!existing && current.length >= SAVED_LAUNCH_SET_LIMIT) {
    throw new Error(`You can save up to ${SAVED_LAUNCH_SET_LIMIT} launch sets.`);
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
  const current = parseSavedLaunchSets(
    storage.getItem(SAVED_LAUNCH_SETS_KEY),
  );
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
