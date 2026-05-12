import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { validateSourcePath } from "../index.js";

// Resolve the allowlist the same way index.js does at startup.
const ALLOWED = [path.resolve("/tmp/")];

test("rejects traversal: /tmp/../etc/passwd", () => {
  assert.throws(
    () => validateSourcePath("/tmp/../etc/passwd", ALLOWED, "test"),
    /must be under one of/
  );
});

test("rejects traversal with dot segment: /tmp/./../etc/passwd", () => {
  assert.throws(
    () => validateSourcePath("/tmp/./../etc/passwd", ALLOWED, "test"),
    /must be under one of/
  );
});

test("rejects nested traversal: /tmp/sub/../../etc/passwd", () => {
  assert.throws(
    () => validateSourcePath("/tmp/sub/../../etc/passwd", ALLOWED, "test"),
    /must be under one of/
  );
});

test("rejects outside path: /etc/passwd", () => {
  assert.throws(
    () => validateSourcePath("/etc/passwd", ALLOWED, "test"),
    /must be under one of/
  );
});

test("rejects relative path: relative/path", () => {
  assert.throws(
    () => validateSourcePath("relative/path", ALLOWED, "test"),
    /must be absolute/
  );
});

test("rejects empty string", () => {
  assert.throws(
    () => validateSourcePath("", ALLOWED, "test"),
    /is required/
  );
});

test("rejects non-string input", () => {
  assert.throws(
    () => validateSourcePath(null, ALLOWED, "test"),
    /is required/
  );
});

test("rejects prefix dir itself: /tmp (no trailing file)", () => {
  // /tmp resolves to /tmp — same as the prefix, not a file under it.
  assert.throws(
    () => validateSourcePath("/tmp", ALLOWED, "test"),
    /must be under one of/
  );
});

test("accepts /tmp/foo.apk", () => {
  const result = validateSourcePath("/tmp/foo.apk", ALLOWED, "test");
  assert.equal(result, path.resolve("/tmp/foo.apk"));
});

test("accepts deeply nested: /tmp/sub/dir/file.apk", () => {
  const result = validateSourcePath("/tmp/sub/dir/file.apk", ALLOWED, "test");
  assert.equal(result, path.resolve("/tmp/sub/dir/file.apk"));
});

test("accepts path with internal dot segments that resolve inside: /tmp/sub/./file.apk", () => {
  const result = validateSourcePath("/tmp/sub/./file.apk", ALLOWED, "test");
  assert.equal(result, path.resolve("/tmp/sub/file.apk"));
});

test("multi-prefix allowlist: accepts paths under any allowed prefix", () => {
  const multi = [path.resolve("/tmp/"), path.resolve("/var/cache/")];
  assert.doesNotThrow(() => validateSourcePath("/tmp/a.apk", multi, "test"));
  assert.doesNotThrow(() => validateSourcePath("/var/cache/b.apk", multi, "test"));
  assert.throws(() => validateSourcePath("/etc/passwd", multi, "test"));
});

test("prefix that does not end with slash still matches subpaths", () => {
  // path.resolve("/tmp/") returns "/tmp" (no trailing slash), but the relative
  // check works correctly regardless. Verify with an explicit no-slash prefix.
  const noSlash = [path.resolve("/tmp")];
  assert.doesNotThrow(() => validateSourcePath("/tmp/x.apk", noSlash, "test"));
  assert.throws(() => validateSourcePath("/tmpfoo/x.apk", noSlash, "test"));
});
