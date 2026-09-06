export type RestoredScrollTopInput = {
  readonly savedTop: number;
  readonly scrollHeight: number;
  readonly followEnd: boolean;
  readonly anchorOffsetBefore?: number;
  readonly anchorOffsetAfter?: number;
};

export type NewMessagesInput = {
  readonly followEnd: boolean;
  readonly previousMessageCount: number;
  readonly currentMessageCount: number;
};

export const shouldOfferNewMessages = (input: NewMessagesInput): boolean =>
  !input.followEnd && input.currentMessageCount > input.previousMessageCount;

/**
 * Keeps the same visible row at the same viewport offset when live content is
 * inserted above it. A reader already following the tail continues following
 * the tail; other readers are never pulled away from what they were reading.
 */
export const restoredScrollTop = (input: RestoredScrollTopInput): number => {
  if (input.followEnd) return Math.max(0, input.scrollHeight);
  if (
    Number.isFinite(input.anchorOffsetBefore)
    && Number.isFinite(input.anchorOffsetAfter)
  ) {
    return Math.max(
      0,
      input.savedTop + (input.anchorOffsetAfter! - input.anchorOffsetBefore!),
    );
  }
  return Math.max(0, input.savedTop);
};
