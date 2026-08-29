// Workspace tree snapshotting and exact byte scoring.
//
// A tree snapshot records every REGULAR file's relative path, UTF-8 byte
// length, and SHA-256. Scoring is exact: a fixture passes only when the
// regular-file sets are identical (no missing/extra files) and every
// file's bytes match the expected tree. Directories and non-regular
// entries (symlinks, sockets, devices) are never followed; they surface
// as extra entries and fail the arm. There is no fuzzy or partial
// credit.

import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256Hex } from "./util.mjs";

/** Recursively snapshot a directory tree into a plain serializable map. */
export async function snapshotTree(rootDir) {
  const files = {};
  const stack = [""];
  while (stack.length > 0) {
    const current = stack.pop();
    const currentPath = join(rootDir, current);
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const relPath = current === "" ? entry.name : `${current}/${entry.name}`;
      const absolute = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(relPath);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        files[relPath] = {
          bytes: bytes.byteLength,
          sha256: sha256Hex(bytes),
        };
      } else if (entry.isSymbolicLink()) {
        // The bench never expects symlinks in a workspace; a stray
        // symlink counts as an extra entry rather than being followed.
        // lstat (not stat) so a broken symlink still records cleanly.
        let targetSize = 0;
        try {
          targetSize = (await lstat(absolute)).size;
        } catch {
          /* unreadable link */
        }
        files[relPath] = {
          bytes: 0,
          sha256: `symlink:${targetSize}`,
          symlink: true,
        };
      } else {
        // Sockets/FIFOs/devices: counted as extras, never hashed.
        files[relPath] = { bytes: 0, sha256: "non-regular", special: true };
      }
    }
  }
  const totalBytes = Object.values(files).reduce(
    (sum, entry) => sum + entry.bytes,
    0,
  );
  return { files, totalBytes };
}

/** Byte-exact comparison of two tree snapshots. */
export function compareTrees(actual, expected) {
  const missing = [];
  const extra = [];
  const changed = [];
  for (const path of Object.keys(expected.files)) {
    if (!(path in actual.files)) {
      missing.push(path);
    } else if (actual.files[path].sha256 !== expected.files[path].sha256) {
      changed.push({
        path,
        actualSha256: actual.files[path].sha256,
        expectedSha256: expected.files[path].sha256,
        actualBytes: actual.files[path].bytes,
        expectedBytes: expected.files[path].bytes,
      });
    }
  }
  for (const path of Object.keys(actual.files)) {
    if (!(path in expected.files)) extra.push(path);
  }
  const match =
    missing.length === 0 && extra.length === 0 && changed.length === 0;
  return { match, missing, extra, changed };
}

/** Convert a tree snapshot to a compact expected-tree record for manifests. */
export function treeRecord(tree) {
  return {
    totalBytes: tree.totalBytes,
    files: Object.fromEntries(
      Object.entries(tree.files)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, entry]) => [
          path,
          { bytes: entry.bytes, sha256: entry.sha256 },
        ]),
    ),
  };
}
