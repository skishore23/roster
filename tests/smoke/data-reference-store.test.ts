import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createArtifactDataReferenceLocator,
  createObjectDataReferenceLocator,
  DurableBlobDataReferenceStore,
  InMemoryDataReferenceStore,
  type ImmutableDataReferenceBlobBackend,
} from "../../src/engine/dataflow/data-reference-store.ts";
import type { DataReference } from "../../src/engine/platform/protocol.ts";
import { createFileSystemDataReferenceStore } from "../../src/engine/dataflow/filesystem-data-reference-store.ts";

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength
  && left.every((value, index) => value === right[index]);

class TestImmutableBlobBackend implements ImmutableDataReferenceBlobBackend {
  private readonly values = new Map<string, Uint8Array>();

  async putImmutable(reference: DataReference, bytes: Uint8Array): Promise<void> {
    const key = this.key(reference);
    const existing = this.values.get(key);
    if (existing && !bytesEqual(existing, bytes)) {
      throw new Error(`Immutable blob ${key} cannot be replaced`);
    }
    if (!existing) this.values.set(key, bytes.slice());
  }

  async read(reference: DataReference): Promise<Uint8Array | undefined> {
    return this.values.get(this.key(reference))?.slice();
  }

  body(reference: DataReference): Uint8Array {
    const value = this.values.get(this.key(reference));
    if (!value) throw new Error(`Missing test blob ${this.key(reference)}`);
    return value.slice();
  }

  tamper(reference: DataReference, bytes: Uint8Array): void {
    this.values.set(this.key(reference), bytes.slice());
  }

  private key(reference: DataReference): string {
    if (reference.storage === "artifact" && reference.artifactId) {
      return `artifact:${reference.artifactId}`;
    }
    if (reference.storage === "object" && reference.uri) {
      return `object:${reference.uri}`;
    }
    throw new Error("Test immutable backend requires a durable locator");
  }
}

test("durability is explicit and text/plain bytes match accepted artifact bytes", async () => {
  const text = "Résumé ready.\nSecond line.";
  const expectedBytes = Buffer.byteLength(text, "utf8");
  const local = new InMemoryDataReferenceStore();
  const localReference = await local.put({ value: text, mediaType: "text/plain" });
  assert.equal(local.durability, "process-local");
  assert.equal(localReference.byteLength, expectedBytes);

  const backend = new TestImmutableBlobBackend();
  const durable = new DurableBlobDataReferenceStore({
    backend,
    locate: createArtifactDataReferenceLocator("roster-results"),
  });
  const reference = await durable.put({ value: text, mediaType: "text/plain" });

  assert.equal(durable.durability, "durable");
  assert.equal(reference.storage, "artifact");
  assert.ok(reference.artifactId?.startsWith("roster-results:blob_"));
  assert.match(reference.artifactId ?? "", /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
  assert.equal(reference.byteLength, expectedBytes);
  assert.equal(backend.body(reference).byteLength, expectedBytes);
  assert.equal(Buffer.from(backend.body(reference)).toString("utf8"), text);
  await assert.rejects(
    durable.put({ value: "unsafe", mediaType: "text/plain", artifactId: "unsafe/id" }),
    /Artifact data reference id contains unsafe characters/,
  );

  const afterRestart = new DurableBlobDataReferenceStore({
    backend,
    locate: createArtifactDataReferenceLocator("roster-results"),
  });
  assert.equal(await afterRestart.read(reference), text);
});

test("canonical JSON survives restart through an object-backed store", async () => {
  const backend = new TestImmutableBlobBackend();
  const first = new DurableBlobDataReferenceStore({
    backend,
    locate: createObjectDataReferenceLocator("memory://roster-data"),
  });
  const value = {
    z: 3,
    a: {
      second: true,
      first: ["one", "two"],
    },
  } as const;
  const reference = await first.put({ value, mediaType: "application/json" });

  assert.equal(reference.storage, "object");
  assert.ok(reference.uri?.startsWith("memory://roster-data/blob_"));
  assert.equal(
    Buffer.from(backend.body(reference)).toString("utf8"),
    '{"a":{"first":["one","two"],"second":true},"z":3}',
  );
  assert.equal(reference.byteLength, backend.body(reference).byteLength);

  const afterRestart = new DurableBlobDataReferenceStore({
    backend,
    locate: createObjectDataReferenceLocator("memory://roster-data"),
  });
  assert.deepEqual(await afterRestart.read(reference), value);
});

test("filesystem-backed references survive a fresh production store instance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-data-reference-"));
  try {
    const first = createFileSystemDataReferenceStore({
      directory,
      namespace: "coding-run",
    });
    const reference = await first.put({
      value: { title: "Changelog", count: 2 },
      mediaType: "application/json",
    });
    const afterRestart = createFileSystemDataReferenceStore({
      directory,
      namespace: "coding-run",
    });
    assert.equal(afterRestart.durability, "durable");
    assert.match(reference.artifactId ?? "", /^roster-data:[a-f0-9]{40}:blob_[a-f0-9]{40}$/u);
    assert.deepEqual(await afterRestart.read(reference), {
      title: "Changelog",
      count: 2,
    });
    assert.deepEqual(
      await afterRestart.put({
        value: { title: "Changelog", count: 2 },
        mediaType: "application/json",
      }),
      reference,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable reads reject changed lengths, hashes, canonical bytes, and reference identities", async () => {
  const backend = new TestImmutableBlobBackend();
  const store = new DurableBlobDataReferenceStore({
    backend,
    locate: createObjectDataReferenceLocator("memory://tamper-test"),
  });
  const reference = await store.put({
    value: { answer: "yes", order: 1 },
    mediaType: "application/json",
  });
  const original = backend.body(reference);

  backend.tamper(reference, Uint8Array.from([...original, 0x20]));
  await assert.rejects(store.read(reference), /changed byte length/);

  const sameLengthChangedValue = new TextEncoder().encode('{"answer":"no!","order":1}');
  assert.equal(sameLengthChangedValue.byteLength, original.byteLength);
  backend.tamper(reference, sameLengthChangedValue);
  await assert.rejects(store.read(reference), /changed content hash/);

  const nonCanonicalSameValue = new TextEncoder().encode('{"order":1,"answer":"yes"}');
  assert.equal(nonCanonicalSameValue.byteLength, original.byteLength);
  backend.tamper(reference, nonCanonicalSameValue);
  await assert.rejects(store.read(reference), /does not contain canonical JSON/);

  backend.tamper(reference, original);
  await assert.rejects(
    store.read({ ...reference, byteLength: reference.byteLength + 1 }),
    /invalid reference identity/,
  );
  await assert.rejects(
    store.read({ ...reference, contentHash: "0".repeat(64) }),
    /invalid reference identity/,
  );
});
