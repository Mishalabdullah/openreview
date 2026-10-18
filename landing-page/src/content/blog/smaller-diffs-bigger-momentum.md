---
title: Smaller diffs. Bigger momentum.
description: The underrated engineering practice that makes teams move faster.
pubDate: 2026-10-15
category: Engineering
cover: diff
---

A large pull request often begins with a small, sensible change. Then comes a cleanup, a rename, a dependency update, and a fix for something discovered along the way. By the time it reaches review, the original idea is hard to find.

Keeping diffs focused is not about chasing an arbitrary line count. It is about making the cost of understanding a change proportional to the idea behind it.

## 01 — Reduce the context switch.

Every unrelated change asks the reviewer to load a new mental model. A formatting adjustment next to a behavior change can make the behavior harder to see. An opportunistic refactor can obscure a bug fix that would otherwise be obvious.

Separate those changes when you can. A preparatory refactor can establish a clean interface. The next pull request can use it. Each review then has one question to answer rather than several tangled together.

There are exceptions. Some changes are clearer when presented together. The useful test is not “could I split this?” but “would splitting this make the reasoning easier to follow?”

## 02 — Design for a useful review.

Before you start, write a one-sentence description of the change. If you cannot describe it without several uses of “and,” you may have more than one reviewable idea.

> “A focused diff gives attention somewhere to land.”

Make the boundary match a behavior, not an arbitrary set of files. A small feature might touch a handler, a service, and a test. Those files belong together because they tell the same story.

```typescript
// One behavior, with an explicit boundary.
export function canReview(member: Member) {
  return member.permissions.includes('review');
}
```

Keep the tests alongside the behavior they demonstrate. A reviewer should be able to connect an implementation choice to evidence of what it is expected to do.

## 03 — Keep the work moving.

Focused changes tend to be easier to pick up between other tasks. They also make it easier to give an accurate review, revise the implementation, and decide when the work is ready.

The benefits continue after merging. A coherent history is easier to investigate. A regression is easier to isolate. A revert is less likely to undo unrelated improvements.

Start with your next pull request. Remove one unrelated cleanup. Write down the intent. Read the diff as if you were seeing it for the first time. You may find that shipping a little less at once helps the whole team move forward.
