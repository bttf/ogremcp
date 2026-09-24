# Development process

Every unit of work follows this loop. The orchestrator (the main Claude session)
never reads or writes implementation files directly; it delegates, triages, and
reports. This keeps the orchestrator's context available for the whole project
rather than a single issue.

## Roles

**Orchestrator** — the main session. Reads Linear, writes task briefs, spawns
subagents, triages review findings, updates Linear, talks to the user. Reads
subagent reports and PR metadata, not source files.

**Implementer** — `.claude/agents/implementer.md`. Runs in an isolated git
worktree. Implements one unit of work, runs the build and tests, opens a PR,
reports a summary.

**Reviewer** — `.claude/agents/reviewer.md`. Fresh context. Sees the PR diff and
the Linear issue, never the implementation conversation. Reports findings by
severity.

## The loop

1. **Brief.** Orchestrator reads the Linear issue and the § of
   `docs/architecture.md` it cites, and writes a task brief: scope, acceptance
   criteria, files in play, explicit non-goals.
2. **Start.** Move the Linear issue to **In Progress**.
   `linear -w redpinesoftware issue update RED-NNN -s "In Progress"`
3. **Implement.** Spawn an implementer subagent with `isolation: "worktree"`.
   Branch name: `red-NNN-short-slug`.
4. **PR.** The implementer opens a draft PR against `main` with a body linking
   the Linear issue and citing its §. It reports back: what changed, how it was
   verified, what it deliberately left out, and anything it could not resolve.
5. **Review.** Spawn a reviewer subagent with the PR number and the issue key.
   It runs `gh pr diff` itself; the orchestrator does not paste the diff.
6. **Triage.** Orchestrator classifies findings:
   - *Blocker* — wrong behavior, security problem, breaks a contract in
     `@ogmcp/sdk` or `docs/architecture.md`, or misses an acceptance criterion.
     Goes back to the implementer.
   - *Non-blocking* — style, naming, future refactor. Recorded in the PR body or
     a follow-up Linear issue. Not fixed now.
   Re-review after a non-trivial fix.
7. **Ready.** When no blockers remain, mark the PR ready for review and move the
   Linear issue to **In Review**.
8. **Report.** Orchestrator brings it to the user: the issue, what changed, what
   review found, how blockers were resolved, what is deliberately still open.
9. **Go-ahead.** The user gives final approval. Remove the agent worktrees
   first (`git worktree remove`), since a worktree holding the branch makes
   `gh pr merge --delete-branch` fail. Then merge and delete the branch. Move
   the issue to **Done** unless more PRs are planned for it.

Blockers are resolved before step 8. The user reviews finished work, not
work-in-progress.

## Rules

- One Linear issue per branch. An issue may produce more than one PR if it is
  large; a PR never spans two issues.
- The implementer never merges its own PR and never runs `git push --force` on
  `main`.
- The reviewer never edits code. It reports only.
- Subagents report summaries. They do not dump file contents back to the
  orchestrator.
- A subagent blocked on a credential, an irreversible action, or a genuine
  ambiguity stops and reports. The orchestrator resolves it or escalates to the
  user. Subagents do not guess at credentials.
- Every commit is signed off for the DCO: `git commit -s`.
- Anything that touches production data, the Railway project, or a live
  deploy is escalated to the user before it runs.

## Linear conventions

Workspace `redpinesoftware`, team `RED`, project **Open Gamer MCP**. Every
command needs `-w redpinesoftware`. The Linear MCP connector cannot see this
workspace.

Every issue cites the § of `docs/architecture.md` it implements. Milestones,
package labels, and decision issues follow §18.4.

| Moment                | State       |
| --------------------- | ----------- |
| Branch opened         | In Progress |
| PR ready for review   | In Review   |
| PR merged             | Done        |

Post the PR URL as a comment on the issue when it opens.
