import type { Branch, BranchStore, Chain, Receipt, Store } from "../core/types.js";

/** Fast deterministic persistence for unit tests and simulations only. */
export const memoryStore = <Body>(): Store<Body> => {
  const streams = new Map<string, Receipt<Body>[]>();
  const rows = (stream: string): Receipt<Body>[] => {
    const found = streams.get(stream);
    if (found) return found;
    const created: Receipt<Body>[] = [];
    streams.set(stream, created);
    return created;
  };
  return {
    append: async (receipt) => {
      rows(receipt.stream).push(receipt);
    },
    read: async (stream): Promise<Chain<Body>> => [...rows(stream)],
    take: async (stream, count): Promise<Chain<Body>> => rows(stream).slice(0, count),
    count: async (stream) => rows(stream).length,
    head: async (stream) => rows(stream).at(-1),
  };
};

/** In-memory branch metadata companion for tests and simulations only. */
export const memoryBranchStore = (): BranchStore => {
  const branches = new Map<string, Branch>();
  return {
    save: async (branch) => {
      branches.set(branch.name, { ...branch });
    },
    get: async (name) => {
      const branch = branches.get(name);
      return branch ? { ...branch } : undefined;
    },
    list: async () => [...branches.values()].map((branch) => ({ ...branch })),
    children: async (parent) => [...branches.values()]
      .filter((branch) => branch.parent === parent)
      .map((branch) => ({ ...branch })),
  };
};
