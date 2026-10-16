# Worktree copying

`omp worktree add --detach <destination> <commit>` uses `worktree.clone` (default true) and `isolation.backend` to try a native clone, then falls back to a checkout. Destinations must not overlap the source: existing ancestor identities are checked in addition to resolved paths, and directory-copy backends skip the destination root identity during traversal. Symlinks are copied as links, never followed.

## Contents

- Tracked live files are cloned and reconciled to the requested commit.
- By default untracked files are not copied. `--keep-changes` preserves staged, unstaged and non-ignored untracked state and requires the source HEAD as the target.
- Ignored caches, generated outputs, and nested repositories/worktrees are excluded. Tracking a generated file keeps it included.
- Required ignored assets must be named explicitly. Set `worktree.include` to an array of gitignore-style patterns, or commit `.omp/worktree-include`, one pattern per line. Both are relative to the repository root; positive patterns include files, `!` patterns cancel an earlier include, and comments/blank lines are supported. Settings lines are applied after repository lines. These patterns never include Git administration or nested repositories. The same policy applies when cloning falls back or is disabled.

For example, a project needing conversion tools can use:

```text
# .omp/worktree-include
/local/convert/
/godot/native/bin/libpz_godot.so
!/local/convert/cache/
```

Or configure `worktree.include: ["/local/convert/", "/godot/native/bin/libpz_godot.so"]`. Include only assets the checkout actually needs; `node_modules`, engine import caches and unrelated local data are not implicitly required. CLI, session worktrees and GitHub PR worktrees use this setting.

## Receipts

`omp worktree add` prints a bounded payload summary; `--json` emits the commit, destination, attempts and `cloneStats`. Only top-level `cloneStats.manifest` contains the full manifest: each copied file has logical bytes, and exclusions are grouped at the first pruned directory/path. `countsMeasured: false` marks pruned directories: their zero counters mean unmeasured, not empty. Symlinks are not counted as regular files. Git administration, nested repository roots and excluded trees are pruned without opening their contents. Display paths use lossy UTF-8 on platforms allowing non-UTF-8 filenames; copying retains native paths.

`filesCopied` and `bytesCopied` are physical clone-operation counters, not final checkout sizes when reconciliation changes the target. Bulk backends derive payload totals from the policy manifest; `traversalMeasured: false` means the backend itself did not walk the tree. A disabled clone with no positive includes skips the tree walk entirely. Include patterns with a literal rooted prefix constrain discovery to that subtree; unanchored or wildcard-leading patterns can require broader discovery. Unreadable directories visited only for include discovery are excluded with `countsMeasured: false`. Policy status is collected only for `--keep-changes`; source status is refreshed after copying (and after fallback checkout) so concurrent edits are reconciled rather than hidden by index stat refresh.

All times are wall milliseconds: `policyMs` covers policy/index/status work, `traversalMs` covers policy enumeration and backend enumeration, `copyMs` covers backend file/link/directory copying, `branchMs` covers branch-ref creation (including CLI-created branches), `registerMs` covers linked-worktree administration and clone-path index installation, `reconcileMs` covers target/dirty-state reconciliation, and `checkoutMs` covers a fallback's checkout including index creation. `totalMs` retains its legacy meaning of the native clone call only. Consequently policy/traversal/total are enclosing or overlapping measurements, not additive phases. Failed attempts retain partial counters/times and `cleanupMs`.

Bash rewrites carry `rewriteKind`, redacted requested/executed command, owning session/agent, OMP parent PID and executable, and managed job ID (or an explicit unavailable reason). Worktree rewrites are visibly labelled `git worktree add → omp worktree add` and show the actual executable command. Wrapper-only dispatches do not emit rewrite notices.

## Final-binary comparison (2026-10-16)

Source: `/home/john/projects/zomboid-3d`, commit `6ee8d7ae76a9c1c1db1f8efd3ac7a84127453d68`. CLI build base: `09fa0d1217dfcae54cf338e7304abf842d455fd5` plus the uncommitted rollout fixes; binary SHA-256: `9f3e7c674e517bbe90957a9468fb14ff27890a4f9df363458a794467c3581696`. The rebuilt `dist/omp` addon was warmed with one discarded add. Both commands used `core.hooksPath=/dev/null`, the same source and sibling destinations on the same filesystem. Order was ABBAAB, A=native, B=Git; every destination was removed immediately after measurement.

All timings are milliseconds. Git exposes only end-to-end wall here; its internal phases are not inferred.

| Run | Wall | Policy | Traversal | Copy | Register | Branch | Reconcile | Checkout | Files | Bytes | Meter ID |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| native-1 | 582.4 | 62.32 | 86.05 | 305.90 | 0.142 | 0 | 51.35 | 0 | 10,026 | 113,924,495 | `01M51QY54F8NJ67VS2SHJQTJMR` |
| git-1 | 187.6 | — | — | — | — | — | — | — | 10,026 | 113,858,149* | `01M51QY60M5X3VXTWNDTAMYF32` |
| git-2 | 191.2 | — | — | — | — | — | — | — | 10,026 | 113,858,149* | `01M51QY6H6FNJAMMJN936TV8YB` |
| native-2 | 826.0 | 63.42 | 116.49 | 510.21 | 0.159 | 0 | 54.39 | 0 | 10,026 | 113,924,495 | `01M51QY725FY6XYTMQ1QJY6ME9` |
| native-3 | 652.7 | 60.98 | 89.94 | 367.74 | 0.136 | 0 | 55.40 | 0 | 10,026 | 113,924,495 | `01M51QY86X8VWSEMBFS5ZGX4PB` |
| git-3 | 223.1 | — | — | — | — | — | — | — | 10,026 | 113,858,149* | `01M51QY95AYNNRRJBS6TMYNJE7` |

`*` Git bytes are HEAD blob sizes, not measured checkout I/O. Native copied 10,026 tracked files and **zero included ignored/untracked files** on this source; in general configured includes add files that ordinary Git does not copy. Native counters describe live source bytes, including a 66,346-byte CRLF/filter difference from HEAD blobs, not byte-identical outputs. All native runs used reflink; detached runs performed no branch creation. Traversal overlaps policy and clone totals; do not sum those enclosing measurements.

Median wall: native **652.7 ms**, Git **191.2 ms** (native 3.41× slower). The copy phase dominates: per-file reflink clones of the 10,026 files took 306–510 ms, more than Git's whole checkout from its object store. On a source with no included ignored assets, native cloning therefore costs time without adding content. Native runs 2 and 3 were flagged noisy; this small series is not a controlled speedup claim. The source worktree list was unchanged after all removals. Full receipts, copied-set classification and cleanup evidence: `/home/john/projects/res27-omp-bench/evidence/final-comparison.json`; checks: `final-checks.json` in the same directory.
