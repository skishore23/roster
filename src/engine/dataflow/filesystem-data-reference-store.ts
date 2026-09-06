import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { hashCanonical } from "../../core/canonical.js";
import {
  DurableBlobDataReferenceStore,
  createArtifactDataReferenceLocator,
  type DataReferenceStoreLimits,
  type ImmutableDataReferenceBlobBackend,
} from "./data-reference-store.js";
import type { DataReference } from "../platform/protocol.js";

const REFERENCE_ID = /^data_[a-f0-9]{32}$/u;

const referencePath = (directory: string, reference: DataReference): string => {
  if (!REFERENCE_ID.test(reference.referenceId)) {
    throw new Error(`Filesystem data reference ${reference.referenceId} has an unsafe identity`);
  }
  return join(directory, reference.referenceId.slice(5, 7), `${reference.referenceId}.blob`);
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));

export class FileSystemImmutableDataReferenceBlobBackend
implements ImmutableDataReferenceBlobBackend {
  readonly directory: string;

  constructor(directory: string) {
    const normalized = resolve(directory.trim());
    if (!directory.trim() || !isAbsolute(normalized)) {
      throw new Error("Filesystem data-reference directory must be absolute");
    }
    this.directory = normalized;
  }

  async putImmutable(
    reference: DataReference,
    bytes: Uint8Array,
    control: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    if (control.signal?.aborted) throw control.signal.reason;
    const path = referencePath(this.directory, reference);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(path);
      if (!sameBytes(existing, bytes)) {
        throw new Error(`Filesystem data reference ${reference.referenceId} changed after publication`);
      }
    }
    if (control.signal?.aborted) throw control.signal.reason;
  }

  async read(
    reference: DataReference,
    control: { readonly signal?: AbortSignal } = {},
  ): Promise<Uint8Array | undefined> {
    if (control.signal?.aborted) throw control.signal.reason;
    try {
      const bytes = await readFile(referencePath(this.directory, reference));
      if (control.signal?.aborted) throw control.signal.reason;
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export const createFileSystemDataReferenceStore = (input: {
  readonly directory: string;
  readonly namespace: string;
  readonly limits?: DataReferenceStoreLimits;
}): DurableBlobDataReferenceStore => {
  const namespace = input.namespace.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(namespace)) {
    throw new Error("Filesystem data-reference namespace is invalid");
  }
  return new DurableBlobDataReferenceStore({
    backend: new FileSystemImmutableDataReferenceBlobBackend(input.directory),
    locate: createArtifactDataReferenceLocator(
      `roster-data:${hashCanonical(namespace).slice(0, 40)}`,
    ),
    ...(input.limits ? { limits: input.limits } : {}),
  });
};
