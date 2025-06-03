 # Plan for “Self-Correcting” `apply_patch` in TypeScript

 _Last updated: 2025-06-03_

 ## Goal

 Evolve the existing `codex-cli` TypeScript `apply_patch` logic so that:

 - **Correctness** is maximized against LLM-generated diffs (no hidden mis-applies).
 - **Resiliency** remains: minor context drift, common Unicode quirks and random gibberish are auto-healed whenever safe.
 - We avoid a full AST rewrite or shipping a Rust binary—this remains a pure TS module.

 ---

 ## 1. Current Baseline

 - **Heuristic parser** in `apply-patch.ts` with:
   - Multi-pass context matching (strict, trimEnd, trimBoth, Unicode-normalize).
   - A big “punctuation equivalence” map to canonicalize dashes, quotes, spaces.
   - Spawns the `apply_patch` CLI and captures stdout/stderr.
   - Forgives many errors by bumping a “fuzz” score rather than hard-failing.

 **Pros**  
 - Integrates seamlessly into the JS agent loop.  
 - Tolerant of small context mismatches.  

 **Cons**  
 - Too forgiving: silent mis-applies can happen if context is badly drifted.  
 - Complex Unicode table bulky to maintain.  
 - Hard to reason about edge-case behavior.

 ---

 ## 2. High-Level Enhancements

 We will layer in multiple self-healing “micro-features” without throwing out the existing multi-pass engine:

 1. **Patch Sanitizer**  
    - Strip non-diff lines (anything not beginning with `***`,`---`,`+++`,`@@`,` `, `+`, `-`).  
    - Drop malformed or empty hunks before parsing.

 2. **Hunk Header Auto-Repair**  
    - Normalize common header typos:  
      - Missing counts → insert `,0` (e.g. `@@ -12 +12 @@` ⇒ `@@ -12,0 +12,0 @@`).  
      - Commas vs. spaces (`@@ -12 3 +12 3 @@` → `@@ -12,3 +12,3 @@`).  
    - If a parse-error occurs, attempt a small regex rewrite before bailing.

 3. **Mini-Normalization Pass**  
    - Beyond existing Unicode map, always:  
      - `.trimEnd()` each line  
      - Normalize `\r\n` → `\n`  
    - Warn (but don’t fail) on invalid control or non-UTF8 characters, then strip them.

 4. **Greedy Levenshtein-Fallback**  
    - Merged into `find_context`: after the standard multi-pass (strict, trimEnd, trimBoth, normalize)
      we scan ±2 lines around the given anchor. If ≥80% of the context lines match exactly at
      any shifted offset, we accept that location.
    - We bump the fuzz score when using this fallback so it can be audited later.

 5. **Hunk-Level Consistency Check**  
    - After insert/delete splice, verify actual line-counts == header counts.  
    - On mismatch: rollback that hunk and emit an error summary.

 6. **Selective Unicode Table Pruning**  
    - Keep only the 5–10 highest-frequency substitution entries (e.g. U+201C, U+00A0, U+200B).  
    - Drop the rest to shrink cognitive overhead.

 7. **Context-Drift Repairs**  
    - If a hunk’s context lines 1–3 match but 4–6 don’t, shift the start by the number of failing lines (up to 2) and re-apply.

 8. **Interactive Recovery Hooks**  
    - On unfixable hunk:  
      - Display patch context vs. file context diff.  
      - Optionally prompt “Drop this hunk? Retry with manual fix?” in interactive mode.

 ---

 ## 3. Detailed Feature Breakdown

 ### 3.1 Patch Sanitizer  
 • Regex‐filter the raw heredoc body to only lines matching unified‐diff tokens.  
 • Benefits: Strips stray LLM annotations before they pollute parsing.

 ### 3.2 Hunk Header Auto-Repair  
 • Pre-parse transform on lines like `@@ -A B +C D @@` → enforce `A,B` and `C,D`.  
 • Implement as small regex substitutions; bail if still unparsable.

 ### 3.3 Mini-Normalization Pass  
 ```ts
 const normalizeLine = (s: string) =>
   s.replace(/\r\n/g, "\n").trimEnd();
 ```
 • Run on both patch context & target file buffer before any matching.

 ### 3.4 Greedy Levenshtein-Fallback  
1. Already implemented in `find_context` (Phase 4+ fallback).
2. After strict, trimEnd, trimBoth, and Unicode-normalized passes, scan offsets in `[start-2 .. start+2]`.
3. If `(matches / contextLen) ≥ 0.8`, accept and bump fuzz by +50k.

 ### 3.5 Hunk-Level Consistency Check  
 After splicing:
 ```ts
 if (addedCount !== headerAddCount || delCount !== headerDelCount) {
   rollbackHunk();
   throw new Error("Hunk counts mismatch");
 }
 ```

 ### 3.6 Selective Unicode Table  
 Pare down `PUNCT_EQUIV` to the most critical entries:
 ```ts
 const PUNCT_EQUIV = {
   "\u201C": '"', "\u201D": '"',
   "\u2018": "'", "\u2019": "'",
   "\u00A0": " ", "\u200B": "",
 };
 ```

 ### 3.7 Context-Drift Repairs  
 If context lines `[i…i+N)`:  
 1. Identify first contiguous good prefix.  
 2. Shift start by bad‐prefix length ≤2.  
 3. Retry matching/patching.

 ### 3.8 Interactive Recovery Hooks  
 - Hook into the CLI’s prompt layer.  
 - On hunk error, show diff via `jsdiff` and ask:  
   `Apply modified hunk anyway? [y/N]`

 ---

 ## 4. Estimated Effort & Phasing

 | Phase | Scope                                    | Rough Size      |
 |-------|------------------------------------------|-----------------|
 | 1     | Sanitizer + Mini-Normalization           | ~50 LOC, 1 day  |
 | 2     | Header Auto-Repair + Count Check         | ~80 LOC, 1 day  |
 | 3     | Levenshtein-Fallback                     | ~150 LOC, 2 days|
 | 4     | Context-Drift Repair                     | ~100 LOC, 1 day |
 | 5     | Interactive Hooks (optional)             | ~100 LOC, 1 day |
 | 6     | Testing & Documentation                  | ~150 LOC, 2 days|

 _Total: ~10–12 days for a single engineer_ (can be parallelized or trimmed based on priority).

 ---

 ## 5. Next Steps

 1. **Review & prioritize** which micro-features to pick first.  
 2. Draft a PR outline / epic with sub-tasks per phase.  
 3. Begin implementation in a feature branch.  
 4. Validate on real LLM-generated diffs and iterate thresholds.  
 5. Merge and release once stable.

 > With this roadmap, you’ll retain the flexibility of the JS agent loop while significantly reducing patch-apply flakiness from LLM noise.