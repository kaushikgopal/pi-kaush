import { open } from "node:fs/promises";
import { constants } from "node:fs";

export const LOCAL_READ_CAP_BYTES = 4 * 1024 * 1024;

export type BoundedFileRead = {
  bytes: Buffer;
  truncated: boolean;
  device: number;
  inode: number;
  links: number;
};

export type BoundedTextRead = BoundedFileRead & { text: string };

/** Read at most cap + 1 bytes from one opened regular-file descriptor. */
export async function readBoundedFile(
  path: string,
  cap = LOCAL_READ_CAP_BYTES,
  signal?: AbortSignal,
): Promise<BoundedFileRead> {
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new Error("File read cap must be a non-negative safe integer.");
  }
  signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new Error(`Only regular files can be read: ${path}`);
    if (info.size > cap) {
      return {
        bytes: Buffer.alloc(0),
        truncated: true,
        device: info.dev,
        inode: info.ino,
        links: info.nlink,
      };
    }
    const wanted = cap + 1;
    const buffer = Buffer.allocUnsafe(wanted);
    let offset = 0;
    while (offset < wanted) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        wanted - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const bytes = buffer.subarray(0, Math.min(offset, cap));
    return {
      bytes,
      truncated: offset > cap || info.size > cap,
      device: info.dev,
      inode: info.ino,
      links: info.nlink,
    };
  } finally {
    await handle.close();
  }
}

export async function readBoundedText(
  path: string,
  cap = LOCAL_READ_CAP_BYTES,
  signal?: AbortSignal,
): Promise<BoundedTextRead> {
  const result = await readBoundedFile(path, cap, signal);
  return { ...result, text: result.bytes.toString("utf8") };
}

export async function assertRegularFile(
  path: string,
  cap?: number,
): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new Error(`Only regular files can be read: ${path}`);
    if (cap !== undefined && info.size > cap) {
      throw new Error(`File exceeds the ${cap}-byte safety cap.`);
    }
  } finally {
    await handle.close();
  }
}
