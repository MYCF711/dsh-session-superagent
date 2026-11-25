---
name: dsh-session-superagent-github
description: Read and handle GitHub issues, pull requests, reviews, and watcher state with the session superagent tools.
---

Use `repo_here` to identify the repository of the current checkout when it is not already explicit. Use `watch_status` to inspect existing watchers before creating or changing one. When a user asks why an item did not wake the session, use `watch_trace` with the repository and issue or pull-request number instead of guessing from its current labels.

Use `github` for GitHub REST reads. Start from the original issue or pull request, then read its timeline as needed: `repos/OWNER/REPO/issues/NUMBER` for the body, `repos/OWNER/REPO/issues/NUMBER/comments` for issue and pull-request conversation comments, `repos/OWNER/REPO/pulls/NUMBER/comments` for review comments, `repos/OWNER/REPO/pulls/NUMBER/reviews` for reviews, and `repos/OWNER/REPO/commits/SHA/check-runs` for CI. Follow pagination until the relevant context is complete; do not treat a truncated first page as the whole discussion. Preserve comment IDs, review-thread root IDs, paths, lines, and URLs when reporting evidence. Reads do not acknowledge an item or advance a watermark.

For a review comment URL ending in `#discussion_rID`, identify the root comment of that review thread before answering. Reply through `github` with method `POST`, path `repos/OWNER/REPO/pulls/NUMBER/comments/ROOT_ID/replies`, a JSON `body` containing the reply text, and `confirm: true`. Do not use the issue-comment endpoint for a review-thread reply. Resolve a thread only after its concern is actually addressed, using the GitHub GraphQL `resolveReviewThread` mutation through `github`; a resolution is not a substitute for an explanatory reply.

Use `watch_ack` only after an issue or pull request is handled. It applies the acknowledgement label and advances the local issue-watch watermark; its `number` is written without `#`. A `note` records the disposition, while `comment: true` also posts that note and therefore requires non-empty note text. For pull-request comment watches, `watch_pr_ack` advances only the local comment watermark; it neither posts a reply nor resolves a review thread. Never use either acknowledgement tool as a substitute for the requested implementation, verification, or source-thread response.

All writes through `github` require `confirm: true`. Before writing, report the intended target and content, then read the result back when the operation matters. Keep credentials inside the plugin and do not place tokens in paths, bodies, notes, comments, or output.
