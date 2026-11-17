import assert from "node:assert/strict";
import test from "node:test";
import {
  LAUNCH_SET_PROFILE_LIMIT,
  normalizeStartingUrl,
  parseSavedLaunchSets,
  removeSavedLaunchSet,
  upsertSavedLaunchSet,
} from "./launch-sets.ts";

test("starting URLs default to HTTPS and refuse non-web or credential URLs", () => {
  assert.equal(
    normalizeStartingUrl("example.com/path"),
    "https://example.com/path",
  );
  assert.equal(
    normalizeStartingUrl("https://example.com"),
    "https://example.com/",
  );
  assert.equal(normalizeStartingUrl(""), undefined);
  for (const bad of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "not a url at all",
    "x".repeat(2_049),
  ]) {
    assert.equal(normalizeStartingUrl(bad), null, bad);
  }
});

test("saved launch sets trim names, de-duplicate profiles and update by name", () => {
  const first = upsertSavedLaunchSet(
    [],
    {
      name: "  QA run  ",
      profileIds: ["p1", "p2", "p1"],
      startUrl: "example.com",
    },
    100,
    () => "set-1",
  );
  assert.equal(first.length, 1);
  assert.equal(first[0].id, "set-1");
  assert.equal(first[0].name, "QA run");
  assert.deepEqual(first[0].profileIds, ["p1", "p2"]);
  assert.equal(first[0].startUrl, "https://example.com/");

  const updated = upsertSavedLaunchSet(
    first,
    { name: "qa run", profileIds: ["p3"], startUrl: "" },
    200,
    () => "unused",
  );
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, "set-1");
  assert.equal(updated[0].updatedAt, 200);
  assert.deepEqual(updated[0].profileIds, ["p3"]);
  assert.equal(updated[0].startUrl, null);
});

test("launch-set input is bounded and invalid values are refused", () => {
  for (const input of [
    { name: " ", profileIds: ["p1"] },
    { name: "valid", profileIds: [] },
    { name: "valid", profileIds: [""] },
    { name: "valid", profileIds: ["p".repeat(129)] },
    {
      name: "valid",
      profileIds: Array(LAUNCH_SET_PROFILE_LIMIT + 1).fill("p"),
    },
    { name: "x".repeat(61), profileIds: ["p1"] },
    { name: "valid", profileIds: ["p1"], startUrl: "javascript:alert(1)" },
  ]) {
    assert.throws(() => upsertSavedLaunchSet([], input, 100, () => "set-1"));
  }
});

test("saved data is validated on read and malformed storage is ignored", () => {
  const valid = {
    id: "set-1",
    name: "Stable",
    profileIds: ["p1", "p2"],
    startUrl: "https://example.com/",
    updatedAt: 100,
  };
  const raw = JSON.stringify([
    valid,
    { ...valid, id: "../bad" },
    { ...valid, name: "" },
    { ...valid, startUrl: "file:///etc/passwd" },
  ]);
  assert.deepEqual(parseSavedLaunchSets(raw), [valid]);
  assert.deepEqual(parseSavedLaunchSets("{broken"), []);
  assert.deepEqual(parseSavedLaunchSets("null"), []);
});

test("deleting a set leaves the other sets untouched", () => {
  const sets = [
    {
      id: "one",
      name: "One",
      profileIds: ["p1"],
      startUrl: null,
      updatedAt: 1,
    },
    {
      id: "two",
      name: "Two",
      profileIds: ["p2"],
      startUrl: null,
      updatedAt: 2,
    },
  ];
  assert.deepEqual(removeSavedLaunchSet(sets, "one"), [sets[1]]);
});


test("launch sets export as a versioned portable file without local row IDs", () => {
  const sets = [
    {
      id: "local-id",
      name: "Nightly QA",
      profileIds: ["profile-a", "profile-b"],
      startUrl: "https://example.com/",
      updatedAt: 123,
    },
  ];
  const raw = serializeSavedLaunchSets(sets, "2026-11-17T00:00:00.000Z");
  const file = JSON.parse(raw);
  assert.equal(file.format, "hiderthbrowser.launch-sets");
  assert.equal(file.version, 1);
  assert.equal(file.exportedAt, "2026-11-17T00:00:00.000Z");
  assert.equal("id" in file.launchSets[0], false);
  assert.equal("updatedAt" in file.launchSets[0], false);
  assert.deepEqual(parseLaunchSetExport(raw), [
    {
      name: "Nightly QA",
      profileIds: ["profile-a", "profile-b"],
      startUrl: "https://example.com/",
    },
  ]);
});

test("launch set import rejects unsupported, duplicate, oversized and unsafe files", () => {
  assert.throws(() => parseLaunchSetExport("{broken"));
  assert.throws(() =>
    parseLaunchSetExport(JSON.stringify({ format: "other", version: 1, launchSets: [] })),
  );
  assert.throws(() =>
    parseLaunchSetExport(JSON.stringify({
      format: "hiderthbrowser.launch-sets",
      version: 2,
      launchSets: [{ name: "QA", profileIds: ["p1"] }],
    })),
  );
  assert.throws(() =>
    parseLaunchSetExport(JSON.stringify({
      format: "hiderthbrowser.launch-sets",
      version: 1,
      launchSets: [
        { name: "QA", profileIds: ["p1"] },
        { name: "qa", profileIds: ["p2"] },
      ],
    })),
  );
  assert.throws(() =>
    parseLaunchSetExport(JSON.stringify({
      format: "hiderthbrowser.launch-sets",
      version: 1,
      launchSets: [{ name: "Unsafe", profileIds: ["p1"], startUrl: "javascript:alert(1)" }],
    })),
  );
});

test("import merges by name and preserves the existing local ID", () => {
  const current = [
    {
      id: "local-existing",
      name: "Daily QA",
      profileIds: ["old-profile"],
      startUrl: null,
      updatedAt: 100,
    },
  ];
  const imported = parseLaunchSetExport(JSON.stringify({
    format: "hiderthbrowser.launch-sets",
    version: 1,
    launchSets: [
      { name: "daily qa", profileIds: ["new-profile"], startUrl: "example.com" },
      { name: "Smoke", profileIds: ["profile-2"], startUrl: null },
    ],
  }));
  const merged = mergeImportedLaunchSets(
    current,
    imported,
    200,
    () => "new-local-id",
  );
  assert.equal(merged.length, 2);
  assert.equal(merged.find((item) => item.name.toLowerCase() === "daily qa")?.id, "local-existing");
  assert.deepEqual(
    merged.find((item) => item.name === "daily qa")?.profileIds,
    ["new-profile"],
  );
  assert.equal(merged.find((item) => item.name === "Smoke")?.id, "new-local-id");
});
