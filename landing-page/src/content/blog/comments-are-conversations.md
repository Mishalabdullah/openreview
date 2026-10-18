---
title: A comment is a conversation, not a verdict.
description: How to give feedback that helps the code—and the person behind it.
pubDate: 2026-10-17
category: Code review
cover: conversation
---

There is a person on the other side of every diff. They have context you do not have, constraints you may not see, and a reason for the choices they made. A good review starts by remembering that.

Technical precision and kindness are not competing goals. The most useful feedback is both clear about the problem and generous toward the person solving it.

## 01 — Ask about the decision.

“Why did you do it this way?” can sound like an accusation. “What tradeoffs led you to this approach?” opens a conversation. The information you need is similar; the invitation feels very different.

Be curious before being certain. An unusual implementation may be working around a dependency, preserving a compatibility guarantee, or handling an edge case that is not visible in the diff. Ask for the missing context before prescribing a solution.

When you do see a problem, name it directly. A vague “this feels wrong” makes the author guess. “This branch returns before the transaction is committed” gives both of you something concrete to investigate.

## 02 — Make the next step clear.

A helpful comment explains the concern and, where possible, offers a path forward. You do not have to write the replacement code, but you should leave the author with more than a negative judgment.

> “Feedback is useful when the next action is easier to see.”

Distinguish a correctness issue from a personal preference. If something must change before merging, say why. If it is an optional suggestion, label it as one. Teams waste surprising amounts of time negotiating the importance of comments instead of discussing their substance.

- **Blocking:** a bug, security problem, or broken contract that needs a resolution.
- **Suggestion:** a potential improvement worth considering.
- **Question:** missing context that would help you understand the change.
- **Nit:** a minor preference that should not hold up the work.

The labels are less important than the shared understanding. Agree on a vocabulary your team actually uses.

## 03 — Close the loop.

A review is not finished when the last comment is posted. It is finished when the team understands the decision and knows what happens next.

As an author, acknowledge feedback and explain your response. “Updated” is fine for a straightforward fix. A tradeoff deserves a sentence about the reasoning. As a reviewer, recognize when the concern has been addressed and resolve the thread.

If a thread keeps getting longer without getting clearer, talk. A short conversation can resolve ambiguity that a dozen comments only amplify. Then write down the decision so the next person can follow it.

The best review does more than improve a patch. It improves the team’s ability to reason together. That is a much more durable outcome than winning an argument about a line of code.
