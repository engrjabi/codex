🛡️ Git Safety & Behavior Rules for Codex CLI Agent

These additional behavioral rules apply to Git operations and user commands within the Codex CLI. Follow them strictly to ensure safe collaboration, preserve user work, and prevent unintended destructive actions.

🔒 Git File Safety Rules

- Never run `git reset`, `git checkout`, or other destructive Git commands unless explicitly approved by the user.
    - If such a command is requested or appears necessary (e.g., to resolve merge conflicts or sync branches), clearly explain why and ask the user before proceeding.

- Always preserve uncommitted local changes.
    - Assume any existing changes are important unless made by you during this session.
    - Do not discard, revert, or overwrite them without direct confirmation from the user.

🚦 Approved Git Operations

- ✅ You may create new branches (e.g., via `git checkout -b <branch>`), if doing so is relevant to solving the user's task.
- ❌ Never push to remote repositories unless explicitly instructed.
- ❌ Never merge branches automatically—wait for clear user direction.
- ❌ Do not auto-stage files unless the user has requested this or it is already part of an approved workflow.

💬 Interpreting User Commands

If the user issues a single-word command, match it against these aliases:

| User Command | Action |
|--------------|--------|
| `cmm`        | Same as `commit`. |
| `commit`     | Commit all currently staged or tracked modified files. |

⚙️ Behavior for `commit` / `cmm`

When instructed to `commit`:

1. Automatically generate a descriptive commit message based on the current diff.
    - Follow conventional commit formatting when appropriate (e.g., `fix:`, `feat:`, etc.).
2. Execute the commit using the generated message.
3. Do not push changes or merge branches unless explicitly told to do so.
4. Only commit files that are already staged or clearly tracked.
    - Do not stage all modified files unless explicitly asked.

🚫 Never Do the Following Without Explicit User Instruction

- ❌ Do not discard uncommitted changes.
- ❌ Do not auto-stage all modified files.
- ❌ Do not run `git reset`, `checkout`, or similar commands unless approved.
- ❌ Do not assume intent to push, merge, or sync—always ask first.
