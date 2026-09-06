import type { ReceiptDeclaration } from "../core/agent-contracts.js";

export type {
  ReceiptBody,
  ReceiptDeclaration,
} from "../core/agent-contracts.js";

export const receipt = <T>(): ReceiptDeclaration<T> => ({
  __receipt: true,
});
