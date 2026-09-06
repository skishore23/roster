import assert from "node:assert/strict";
import test from "node:test";

import {
  restoredScrollTop,
  shouldOfferNewMessages,
} from "../../src/browser/coding-scroll-anchor.js";

test("conversation scroll keeps the visible row fixed when content is inserted above it", () => {
  assert.equal(restoredScrollTop({
    savedTop: 640,
    scrollHeight: 2_400,
    followEnd: false,
    anchorOffsetBefore: 18,
    anchorOffsetAfter: 258,
  }), 880);
});

test("conversation scroll follows the tail only when the reader was already at the tail", () => {
  assert.equal(restoredScrollTop({
    savedTop: 640,
    scrollHeight: 2_400,
    followEnd: true,
  }), 2_400);
});

test("conversation scroll falls back to its saved position when its visible row disappears", () => {
  assert.equal(restoredScrollTop({
    savedTop: 640,
    scrollHeight: 2_400,
    followEnd: false,
    anchorOffsetBefore: 18,
  }), 640);
});

test("conversation offers new messages only when unseen rows arrive away from the tail", () => {
  assert.equal(shouldOfferNewMessages({ followEnd: false, previousMessageCount: 8, currentMessageCount: 10 }), true);
  assert.equal(shouldOfferNewMessages({ followEnd: true, previousMessageCount: 8, currentMessageCount: 10 }), false);
  assert.equal(shouldOfferNewMessages({ followEnd: false, previousMessageCount: 10, currentMessageCount: 10 }), false);
});

test("an incoming row beyond the 80px live edge preserves the reader and increments unread", () => {
  const distanceFromBottom = 81;
  const followEnd = distanceFromBottom <= 80;
  const currentTop = 640;
  const nextTop = restoredScrollTop({
    savedTop: currentTop,
    scrollHeight: 2_520,
    followEnd,
    anchorOffsetBefore: 18,
    anchorOffsetAfter: 18,
  });

  assert.equal(followEnd, false);
  assert.equal(nextTop, currentTop);
  assert.equal(shouldOfferNewMessages({
    followEnd,
    previousMessageCount: 8,
    currentMessageCount: 9,
  }), true);
});
