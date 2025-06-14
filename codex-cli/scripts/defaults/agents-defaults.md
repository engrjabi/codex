

### Git Command Safety

- Do not run destructive commands (e.g., `git reset`, `git checkout`) unless explicitly approved by the user.
  - If such a command seems necessary, clearly explain why and ask for confirmation before proceeding.
- Always preserve uncommitted local changes.
  - Treat all pre-existing uncommitted changes as important unless created by you during this session.
  - Never discard, revert, or overwrite these changes without direct user confirmation.

### Commit Behavior (`commit`)

When processing a `commit` command:

1. **If there are tracked files with uncommitted changes:**  
   - Analyze the current diff and generate a concise, descriptive commit message, following conventional commit formatting where appropriate.
2. **If there are no unsaved changes:**  
   - Review the last commit. If its message is unclear or insufficient, analyze the file changes from that commit and update the message accordingly.
3. Only commit staged or clearly tracked files; do not stage additional files unless explicitly instructed.
4. Do not push or merge changes unless explicitly told to do so.

### Handling Uncommitted Changes

- Before modifying files or running commands, use `git status --porcelain` to check for uncommitted changes.
- If pre-existing uncommitted changes are found (not made in this session), do not modify or discard them automatically.
  - Pause and ask the user how to proceed:
    - Optionally offer to review (`git diff`), stash, or confirm it is safe to continue.

### General Principles

- Never discard or overwrite user code without explicit approval.
- Always respect and preserve pre-existing file changes unless restoring your own session changes.

