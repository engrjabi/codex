// Based on reference implementation from
// https://cookbook.openai.com/examples/gpt4-1_prompting_guide#reference-implementation-apply_patchpy

import fs from "fs";
import path from "path";
import {
  ADD_FILE_PREFIX,
  DELETE_FILE_PREFIX,
  END_OF_FILE_PREFIX,
  MOVE_FILE_TO_PREFIX,
  PATCH_SUFFIX,
  UPDATE_FILE_PREFIX,
  HUNK_ADD_LINE_PREFIX,
  PATCH_PREFIX,
} from "src/parse-apply-patch";

// -----------------------------------------------------------------------------
// Types & Models
// -----------------------------------------------------------------------------

export enum ActionType {
  ADD = "add",
  DELETE = "delete",
  UPDATE = "update",
}

export interface FileChange {
  type: ActionType;
  old_content?: string | null;
  new_content?: string | null;
  move_path?: string | null;
}

export interface Commit {
  changes: Record<string, FileChange>;
}

export function assemble_changes(
  orig: Record<string, string | null>,
  updatedFiles: Record<string, string | null>,
): Commit {
  const commit: Commit = { changes: {} };
  for (const [p, newContent] of Object.entries(updatedFiles)) {
    const oldContent = orig[p];
    if (oldContent === newContent) {
      continue;
    }
    if (oldContent !== undefined && newContent !== undefined) {
      commit.changes[p] = {
        type: ActionType.UPDATE,
        old_content: oldContent,
        new_content: newContent,
      };
    } else if (newContent !== undefined) {
      commit.changes[p] = {
        type: ActionType.ADD,
        new_content: newContent,
      };
    } else if (oldContent !== undefined) {
      commit.changes[p] = {
        type: ActionType.DELETE,
        old_content: oldContent,
      };
    } else {
      throw new Error("Unexpected state in assemble_changes");
    }
  }
  return commit;
}

// -----------------------------------------------------------------------------
// Patch‑related structures
// -----------------------------------------------------------------------------

export interface Chunk {
  orig_index: number; // line index of the first line in the original file
  del_lines: Array<string>;
  ins_lines: Array<string>;
}

export interface PatchAction {
  type: ActionType;
  new_file?: string | null;
  chunks: Array<Chunk>;
  move_path?: string | null;
}

export interface Patch {
  actions: Record<string, PatchAction>;
}

export class DiffError extends Error {}

// -----------------------------------------------------------------------------
// Parser (patch text -> Patch)
// -----------------------------------------------------------------------------

class Parser {
  current_files: Record<string, string>;
  lines: Array<string>;
  index = 0;
  patch: Patch = { actions: {} };
  fuzz = 0;

  constructor(currentFiles: Record<string, string>, lines: Array<string>) {
    this.current_files = currentFiles;
    this.lines = lines;
  }

  private is_done(prefixes?: Array<string>): boolean {
    if (this.index >= this.lines.length) {
      return true;
    }
    if (
      prefixes &&
      prefixes.some((p) => this.lines[this.index]!.startsWith(p.trim()))
    ) {
      return true;
    }
    return false;
  }

  private startswith(prefix: string | Array<string>): boolean {
    const prefixes = Array.isArray(prefix) ? prefix : [prefix];
    return prefixes.some((p) => this.lines[this.index]!.startsWith(p));
  }

  private read_str(prefix = "", returnEverything = false): string {
    if (this.index >= this.lines.length) {
      throw new DiffError(`Index: ${this.index} >= ${this.lines.length}`);
    }
    if (this.lines[this.index]!.startsWith(prefix)) {
      const text = returnEverything
        ? this.lines[this.index]
        : this.lines[this.index]!.slice(prefix.length);
      this.index += 1;
      return text ?? "";
    }
    return "";
  }

  parse(): void {
    while (!this.is_done([PATCH_SUFFIX])) {
      let path = this.read_str(UPDATE_FILE_PREFIX);
      if (path) {
        if (this.patch.actions[path]) {
          throw new DiffError(`Update File Error: Duplicate Path: ${path}`);
        }
        const moveTo = this.read_str(MOVE_FILE_TO_PREFIX);
        if (!(path in this.current_files)) {
          throw new DiffError(`Update File Error: Missing File: ${path}`);
        }
        const text = this.current_files[path];
        const action = this.parse_update_file(text ?? "");
        action.move_path = moveTo || undefined;
        this.patch.actions[path] = action;
        continue;
      }
      path = this.read_str(DELETE_FILE_PREFIX);
      if (path) {
        if (this.patch.actions[path]) {
          throw new DiffError(`Delete File Error: Duplicate Path: ${path}`);
        }
        if (!(path in this.current_files)) {
          throw new DiffError(`Delete File Error: Missing File: ${path}`);
        }
        this.patch.actions[path] = { type: ActionType.DELETE, chunks: [] };
        continue;
      }
      path = this.read_str(ADD_FILE_PREFIX);
      if (path) {
        if (this.patch.actions[path]) {
          throw new DiffError(`Add File Error: Duplicate Path: ${path}`);
        }
        if (path in this.current_files) {
          throw new DiffError(`Add File Error: File already exists: ${path}`);
        }
        this.patch.actions[path] = this.parse_add_file();
        continue;
      }
      throw new DiffError(`Unknown Line: ${this.lines[this.index]}`);
    }
    if (!this.startswith(PATCH_SUFFIX.trim())) {
      throw new DiffError("Missing End Patch");
    }
    this.index += 1;
  }

  private parse_update_file(text: string): PatchAction {
    const action: PatchAction = { type: ActionType.UPDATE, chunks: [] };
    const fileLines = text.split("\n");
    let index = 0;

    // Track expected counts per hunk for consistency check
    let expectedDel = 0;
    let expectedIns = 0;
    while (
      !this.is_done([
        PATCH_SUFFIX,
        UPDATE_FILE_PREFIX,
        DELETE_FILE_PREFIX,
        ADD_FILE_PREFIX,
        END_OF_FILE_PREFIX,
      ])
    ) {
      // Read hunk header counts if present
      const defStr = this.read_str("@@ ");
      if (defStr) {
        // defStr is like "-start,del +start,ins @@"
        const hdr = `@@ ${defStr.trim()}`;
        const m = hdr.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/);
        if (m) {
          expectedDel = parseInt(m[2], 10);
          expectedIns = parseInt(m[4], 10);
        } else {
          expectedDel = 0;
          expectedIns = 0;
        }
      }
      let sectionStr = "";
      if (!defStr && this.lines[this.index] === "@@") {
        sectionStr = this.lines[this.index]!;
        this.index += 1;
      }
      if (!(defStr || sectionStr || index === 0)) {
        throw new DiffError(`Invalid Line:\n${this.lines[this.index]}`);
      }
      if (defStr.trim()) {
        let found = false;
        // ------------------------------------------------------------------
        // Equality helpers using the canonicalisation from find_context_core.
        // (We duplicate a minimal version here because the scope is local.)
        // ------------------------------------------------------------------
        const canonLocal = (s: string): string =>
          s.normalize("NFC").replace(
            /./gu,
            (c) =>
              (
                ({
                  // Dash / hyphen variants
                  "-": "-",
                  "\u2010": "-",
                  "\u2011": "-",
                  "\u2012": "-",
                  "\u2013": "-",
                  "\u2014": "-",
                  "\u2015": "-",
                  "\u2212": "-",

                  // Double quotes
                  "\u0022": '"',
                  "\u201C": '"',
                  "\u201D": '"',
                  "\u201E": '"',
                  "\u201F": '"',
                  "\u00AB": '"',
                  "\u00BB": '"',

                  // Single quotes
                  "\u0027": "'",
                  "\u2018": "'",
                  "\u2019": "'",
                  "\u201A": "'",
                  "\u201B": "'",

                  // Spaces
                  "\u00A0": " ",
                  "\u2002": " ",
                  "\u2003": " ",
                  "\u2004": " ",
                  "\u2005": " ",
                  "\u2006": " ",
                  "\u2007": " ",
                  "\u2008": " ",
                  "\u2009": " ",
                  "\u200A": " ",
                  "\u202F": " ",
                  "\u205F": " ",
                  "\u3000": " ",
                }) as Record<string, string>
              )[c] ?? c,
          );

        if (
          !fileLines
            .slice(0, index)
            .some((s) => canonLocal(s) === canonLocal(defStr))
        ) {
          for (let i = index; i < fileLines.length; i++) {
            if (canonLocal(fileLines[i]!) === canonLocal(defStr)) {
              index = i + 1;
              found = true;
              break;
            }
          }
        }
        if (
          !found &&
          !fileLines
            .slice(0, index)
            .some((s) => canonLocal(s.trim()) === canonLocal(defStr.trim()))
        ) {
          for (let i = index; i < fileLines.length; i++) {
            if (
              canonLocal(fileLines[i]!.trim()) === canonLocal(defStr.trim())
            ) {
              index = i + 1;
              this.fuzz += 1;
              found = true;
              break;
            }
          }
        }
      }

      const [nextChunkContext, chunks, endPatchIndex, eof] = peek_next_section(
        this.lines,
        this.index,
      );
      const [newIndex, fuzz] = find_context(
        fileLines,
        nextChunkContext,
        index,
        eof,
      );
      if (newIndex === -1) {
        const ctxText = nextChunkContext.join("\n");
        if (eof) {
          throw new DiffError(`Invalid EOF Context ${index}:\n${ctxText}`);
        } else {
          throw new DiffError(`Invalid Context ${index}:\n${ctxText}`);
        }
      }
      this.fuzz += fuzz;
      for (const ch of chunks) {
        ch.orig_index += newIndex;
        action.chunks.push(ch);
      }
      index = newIndex + nextChunkContext.length;
      this.index = endPatchIndex;
    }
    return action;
  }

  private parse_add_file(): PatchAction {
    const lines: Array<string> = [];
    while (
      !this.is_done([
        PATCH_SUFFIX,
        UPDATE_FILE_PREFIX,
        DELETE_FILE_PREFIX,
        ADD_FILE_PREFIX,
      ])
    ) {
      const s = this.read_str();
      if (!s.startsWith(HUNK_ADD_LINE_PREFIX)) {
        throw new DiffError(`Invalid Add File Line: ${s}`);
      }
      lines.push(s.slice(1));
    }
    return {
      type: ActionType.ADD,
      new_file: lines.join("\n"),
      chunks: [],
    };
  }
}

function find_context_core(
  lines: Array<string>,
  context: Array<string>,
  start: number,
): [number, number] {
  // ---------------------------------------------------------------------------
  // Helpers – Unicode punctuation normalisation
  // ---------------------------------------------------------------------------

  /*
   * The patch-matching algorithm originally required **exact** string equality
   * for non-whitespace characters.  That breaks when the file on disk contains
   * visually identical but different Unicode code-points (e.g. “EN DASH” vs
   * ASCII "-"), because models almost always emit the ASCII variant.  To make
   * apply_patch resilient we canonicalise a handful of common punctuation
   * look-alikes before doing comparisons.
   *
   * We purposefully keep the mapping *small* – only characters that routinely
   * appear in source files and are highly unlikely to introduce ambiguity are
   * included.  Each entry is written using the corresponding Unicode escape so
   * that the file remains ASCII-only even after transpilation.
   */

  const PUNCT_EQUIV: Record<string, string> = {
    // Hyphen / dash variants --------------------------------------------------
    /* U+002D HYPHEN-MINUS */ "-": "-",
    /* U+2010 HYPHEN */ "\u2010": "-",
    /* U+2011 NO-BREAK HYPHEN */ "\u2011": "-",
    /* U+2012 FIGURE DASH */ "\u2012": "-",
    /* U+2013 EN DASH */ "\u2013": "-",
    /* U+2014 EM DASH */ "\u2014": "-",
    /* U+2015 HORIZONTAL BAR */ "\u2015": "-",
    /* U+2212 MINUS SIGN */ "\u2212": "-",

    // Double quotes -----------------------------------------------------------
    /* U+0022 QUOTATION MARK */ "\u0022": '"',
    /* U+201C LEFT DOUBLE QUOTATION MARK */ "\u201C": '"',
    /* U+201D RIGHT DOUBLE QUOTATION MARK */ "\u201D": '"',
    /* U+201E DOUBLE LOW-9 QUOTATION MARK */ "\u201E": '"',
    /* U+201F DOUBLE HIGH-REVERSED-9 QUOTATION MARK */ "\u201F": '"',
    /* U+00AB LEFT-POINTING DOUBLE ANGLE QUOTATION MARK */ "\u00AB": '"',
    /* U+00BB RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK */ "\u00BB": '"',

    // Single quotes -----------------------------------------------------------
    /* U+0027 APOSTROPHE */ "\u0027": "'",
    /* U+2018 LEFT SINGLE QUOTATION MARK */ "\u2018": "'",
    /* U+2019 RIGHT SINGLE QUOTATION MARK */ "\u2019": "'",
    /* U+201A SINGLE LOW-9 QUOTATION MARK */ "\u201A": "'",
    /* U+201B SINGLE HIGH-REVERSED-9 QUOTATION MARK */ "\u201B": "'",
    // Spaces ------------------------------------------------------------------
    /* U+00A0 NO-BREAK SPACE */ "\u00A0": " ",
    /* U+2002 EN SPACE */ "\u2002": " ",
    /* U+2003 EM SPACE */ "\u2003": " ",
    /* U+2004 THREE-PER-EM SPACE */ "\u2004": " ",
    /* U+2005 FOUR-PER-EM SPACE */ "\u2005": " ",
    /* U+2006 SIX-PER-EM SPACE */ "\u2006": " ",
    /* U+2007 FIGURE SPACE */ "\u2007": " ",
    /* U+2008 PUNCTUATION SPACE */ "\u2008": " ",
    /* U+2009 THIN SPACE */ "\u2009": " ",
    /* U+200A HAIR SPACE */ "\u200A": " ",
    /* U+202F NARROW NO-BREAK SPACE */ "\u202F": " ",
    /* U+205F MEDIUM MATHEMATICAL SPACE */ "\u205F": " ",
    /* U+3000 IDEOGRAPHIC SPACE */ "\u3000": " ",
  };

  const canon = (s: string): string =>
    s
      // Canonical Unicode composition first
      .normalize("NFC")
      // Replace punctuation look-alikes
      .replace(/./gu, (c) => PUNCT_EQUIV[c] ?? c);

  // -----------------------------------------------------------------------
  // Fast-path checks
  // -----------------------------------------------------------------------

  if (context.length === 0) {
    return [start, 0];
  }
  if (context.length > lines.length) {
    // Impossible match – context is longer than the file body.
    return [-1, 0];
  }

  // Search window upper bound (inclusive)
  const maxIndex = lines.length - context.length;

  // -----------------------------------------------------------------------
  // Helper – seek sequence using an element-level transform
  // -----------------------------------------------------------------------

  const seekSequence = (
    transform: (s: string) => string,
  ): number => {
    for (let i = start; i <= maxIndex; i++) {
      let matched = true;
      for (let j = 0; j < context.length; j++) {
        if (transform(lines[i + j]!) !== transform(context[j]!)) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return i;
      }
    }
    return -1;
  };

  // -----------------------------------------------------------------------
  // Pass 1 – strict equality
  // -----------------------------------------------------------------------
  let idx = seekSequence((s) => s);
  if (idx !== -1) {
    return [idx, 0];
  }

  // -----------------------------------------------------------------------
  // Pass 2 – ignore trailing whitespace
  // -----------------------------------------------------------------------
  idx = seekSequence((s) => s.trimEnd());
  if (idx !== -1) {
    return [idx, 1];
  }

  // -----------------------------------------------------------------------
  // Pass 3 – ignore leading & trailing whitespace
  // -----------------------------------------------------------------------
  idx = seekSequence((s) => s.trim());
  if (idx !== -1) {
    return [idx, 100];
  }

  // -----------------------------------------------------------------------
  // Pass 4 – Unicode-normalised comparison
  // -----------------------------------------------------------------------
  idx = seekSequence(canon);
  if (idx !== -1) {
    return [idx, 1000];
  }

  return [-1, 0];
}

function find_context(
  lines: Array<string>,
  context: Array<string>,
  start: number,
  eof: boolean,
): [number, number] {
  // Primary context search
  let idx: number;
  let fuzz: number;
  if (eof) {
    // Honour explicit EOF hunks by trying the end first
    const anchor = lines.length - context.length;
    if (anchor >= 0) {
      [idx, fuzz] = find_context_core(lines, context, anchor);
      if (idx !== -1) {
        return [idx, fuzz];
      }
    }
    // Full scan with EOF penalty
    [idx, fuzz] = find_context_core(lines, context, start);
    fuzz += 10000;
  } else {
    [idx, fuzz] = find_context_core(lines, context, start);
  }
  // Greedy Levenshtein-Fallback: scan ±2 lines for exact prefix match
  if (idx === -1 && context.length > 0) {
    const maxIndex = lines.length - context.length;
    for (let shift = -2; shift <= 2; shift++) {
      const i = start + shift;
      if (i < 0 || i > maxIndex) continue;
      let matchCount = 0;
      for (let j = 0; j < context.length; j++) {
        if (lines[i + j] === context[j]) {
          matchCount++;
        }
      }
      if (matchCount / context.length >= 0.8) {
        // Bump fuzz to indicate fallback
        return [i, fuzz + 50000];
      }
    }
  }
  return [idx, fuzz];
}

/**
 * Greedy Levenshtein-Fallback (±2 line scan) moved into find_context.
 */

function peek_next_section(
  lines: Array<string>,
  initialIndex: number,
): [Array<string>, Array<Chunk>, number, boolean] {
  let index = initialIndex;
  const old: Array<string> = [];
  let delLines: Array<string> = [];
  let insLines: Array<string> = [];
  const chunks: Array<Chunk> = [];
  let mode: "keep" | "add" | "delete" = "keep";

  while (index < lines.length) {
    const s = lines[index]!;
    if (
      [
        "@@",
        PATCH_SUFFIX,
        UPDATE_FILE_PREFIX,
        DELETE_FILE_PREFIX,
        ADD_FILE_PREFIX,
        END_OF_FILE_PREFIX,
      ].some((p) => s.startsWith(p.trim()))
    ) {
      break;
    }
    if (s === "***") {
      break;
    }
    if (s.startsWith("***")) {
      throw new DiffError(`Invalid Line: ${s}`);
    }
    index += 1;
    const lastMode: "keep" | "add" | "delete" = mode;
    let line = s;
    if (line[0] === HUNK_ADD_LINE_PREFIX) {
      mode = "add";
    } else if (line[0] === "-") {
      mode = "delete";
    } else if (line[0] === " ") {
      mode = "keep";
    } else {
      // Tolerate invalid lines where the leading whitespace is missing. This is necessary as
      // the model sometimes doesn't fully adhere to the spec and returns lines without leading
      // whitespace for context lines.
      mode = "keep";
      line = " " + line;

      // TODO: Re-enable strict mode.
      // throw new DiffError(`Invalid Line: ${line}`)
    }

    line = line.slice(1);
    if (mode === "keep" && lastMode !== mode) {
      if (insLines.length || delLines.length) {
        // Hunk-Level Consistency Check before pushing chunk
        if ((expectedDel && delLines.length !== expectedDel) ||
            (expectedIns && insLines.length !== expectedIns)) {
          throw new DiffError(
            `Hunk counts mismatch: expected ${expectedDel} deletions, ${expectedIns} additions; got ${delLines.length} deletions, ${insLines.length} additions`
          );
        }
        chunks.push({
          orig_index: old.length - delLines.length,
          del_lines: delLines,
          ins_lines: insLines,
        });
      }
      delLines = [];
      insLines = [];
    }
    if (mode === "delete") {
      delLines.push(line);
      old.push(line);
    } else if (mode === "add") {
      insLines.push(line);
    } else {
      old.push(line);
    }
  }
  if (insLines.length || delLines.length) {
    // Final hunk-level consistency check
    if ((expectedDel && delLines.length !== expectedDel) ||
        (expectedIns && insLines.length !== expectedIns)) {
      throw new DiffError(
        `Hunk counts mismatch on final chunk: expected ${expectedDel}/${expectedIns}; got ${delLines.length}/${insLines.length}`
      );
    }
    chunks.push({
      orig_index: old.length - delLines.length,
      del_lines: delLines,
      ins_lines: insLines,
    });
  }
  if (index < lines.length && lines[index] === END_OF_FILE_PREFIX) {
    index += 1;
    return [old, chunks, index, true];
  }
  return [old, chunks, index, false];
}

// -----------------------------------------------------------------------------
// High‑level helpers
// -----------------------------------------------------------------------------

/**
 * Filters out any lines that are not valid unified-diff tokens.
 * Keeps only lines starting with ***, ---, +++, @@, space, '+', or '-'.
 */
function sanitize_patch_lines(lines: string[]): string[] {
  const tokenRegex = /^(\*\*\*|---|\+\+\+|@@|[ \+\-]).*/;
  return lines
    .filter((l) => tokenRegex.test(l))
    .map((l) => l.trimEnd());
}

/**
 * Auto-repair common hunk header typos like missing counts or spaces vs commas.
 * Transforms:
 *  - "@@ -12 +12 @@"       → "@@ -12,0 +12,0 @@"
 *  - "@@ -12 3 +12 3 @@"     → "@@ -12,3 +12,3 @@"
 */
function repair_hunk_headers(lines: string[]): string[] {
  const hunkRegex = /^@@ -(\d+)(?:[ ,](\d+))? \+(\d+)(?:[ ,](\d+))? @@$/;
  return lines.map((l) => {
    const m = l.match(hunkRegex);
    if (!m) return l;
    const [, start, delCount, insStart, insCount] = m;
    const dc = delCount ?? '0';
    const ic = insCount ?? '0';
    return `@@ -${start},${dc} +${insStart},${ic} @@`;
  });
}
/**
 * Strip non-printable control characters (excluding tab) from patch lines.
 * Logs a warning when such characters are removed.
 */
function strip_control_chars(lines: string[]): string[] {
  const ctrlRegex = /[\x00-\x08\x0B-\x0C\x0E-\x1F]/g;
  return lines.map((l) => {
    if (ctrlRegex.test(l)) {
      console.warn(`Stripping invalid control characters from patch line: ${JSON.stringify(l)}`);
    }
    return l.replace(ctrlRegex, '');
  });
}

export function text_to_patch(
  text: string,
  orig: Record<string, string>,
): [Patch, number] {
  // Phase 1: Mini-normalization + Patch Sanitizer
  // Normalize line endings and trim global whitespace
  const normalizedText = text.replace(/\r?\n/g, "\n").trim();
  // Split into raw lines and sanitize
  const rawLines = normalizedText.split("\n");
  const sanitized = sanitize_patch_lines(rawLines);
  // Strip invalid control characters
  const cleaned = strip_control_chars(sanitized);
  // Repair hunk headers for missing counts or comma/space typos
  const lines = repair_hunk_headers(cleaned);
  if (
    lines.length < 2 ||
    !(lines[0] ?? "").startsWith(PATCH_PREFIX.trim()) ||
    lines[lines.length - 1] !== PATCH_SUFFIX.trim()
  ) {
    let reason = "Invalid patch text: ";
    if (lines.length < 2) {
      reason += "Patch text must have at least two lines.";
    } else if (!(lines[0] ?? "").startsWith(PATCH_PREFIX.trim())) {
      reason += "Patch text must start with the correct patch prefix.";
    } else if (lines[lines.length - 1] !== PATCH_SUFFIX.trim()) {
      reason += "Patch text must end with the correct patch suffix.";
    }
    throw new DiffError(reason);
  }
  const parser = new Parser(orig, lines);
  parser.index = 1;
  parser.parse();
  return [parser.patch, parser.fuzz];
}

export function identify_files_needed(text: string): Array<string> {
  const lines = text.trim().split("\n");
  const result = new Set<string>();
  for (const line of lines) {
    if (line.startsWith(UPDATE_FILE_PREFIX)) {
      result.add(line.slice(UPDATE_FILE_PREFIX.length));
    }
    if (line.startsWith(DELETE_FILE_PREFIX)) {
      result.add(line.slice(DELETE_FILE_PREFIX.length));
    }
  }
  return [...result];
}

export function identify_files_added(text: string): Array<string> {
  const lines = text.trim().split("\n");
  const result = new Set<string>();
  for (const line of lines) {
    if (line.startsWith(ADD_FILE_PREFIX)) {
      result.add(line.slice(ADD_FILE_PREFIX.length));
    }
  }
  return [...result];
}

function _get_updated_file(
  text: string,
  action: PatchAction,
  path: string,
): string {
  if (action.type !== ActionType.UPDATE) {
    throw new Error("Expected UPDATE action");
  }
  const origLines = text.split("\n");
  const destLines: Array<string> = [];
  let origIndex = 0;
  for (const chunk of action.chunks) {
    if (chunk.orig_index > origLines.length) {
      throw new DiffError(
        `${path}: chunk.orig_index ${chunk.orig_index} > len(lines) ${origLines.length}`,
      );
    }
    if (origIndex > chunk.orig_index) {
      throw new DiffError(
        `${path}: orig_index ${origIndex} > chunk.orig_index ${chunk.orig_index}`,
      );
    }
    destLines.push(...origLines.slice(origIndex, chunk.orig_index));
    const delta = chunk.orig_index - origIndex;
    origIndex += delta;

    // inserted lines
    if (chunk.ins_lines.length) {
      for (const l of chunk.ins_lines) {
        destLines.push(l);
      }
    }
    origIndex += chunk.del_lines.length;
  }
  destLines.push(...origLines.slice(origIndex));
  return destLines.join("\n");
}

export function patch_to_commit(
  patch: Patch,
  orig: Record<string, string>,
): Commit {
  const commit: Commit = { changes: {} };
  for (const [pathKey, action] of Object.entries(patch.actions)) {
    if (action.type === ActionType.DELETE) {
      commit.changes[pathKey] = {
        type: ActionType.DELETE,
        old_content: orig[pathKey],
      };
    } else if (action.type === ActionType.ADD) {
      commit.changes[pathKey] = {
        type: ActionType.ADD,
        new_content: action.new_file ?? "",
      };
    } else if (action.type === ActionType.UPDATE) {
      const newContent = _get_updated_file(orig[pathKey]!, action, pathKey);
      commit.changes[pathKey] = {
        type: ActionType.UPDATE,
        old_content: orig[pathKey],
        new_content: newContent,
        move_path: action.move_path ?? undefined,
      };
    }
  }
  return commit;
}

// -----------------------------------------------------------------------------
// Filesystem helpers for Node environment
// -----------------------------------------------------------------------------

export function load_files(
  paths: Array<string>,
  openFn: (p: string) => string,
): Record<string, string> {
  const orig: Record<string, string> = {};
  for (const p of paths) {
    try {
      orig[p] = openFn(p);
    } catch {
      // Convert any file read error into a DiffError so that callers
      // consistently receive DiffError for patch-related failures.
      throw new DiffError(`File not found: ${p}`);
    }
  }
  return orig;
}

export function apply_commit(
  commit: Commit,
  writeFn: (p: string, c: string) => void,
  removeFn: (p: string) => void,
): void {
  for (const [p, change] of Object.entries(commit.changes)) {
    if (change.type === ActionType.DELETE) {
      removeFn(p);
    } else if (change.type === ActionType.ADD) {
      writeFn(p, change.new_content ?? "");
    } else if (change.type === ActionType.UPDATE) {
      if (change.move_path) {
        writeFn(change.move_path, change.new_content ?? "");
        removeFn(p);
      } else {
        writeFn(p, change.new_content ?? "");
      }
    }
  }
}

export function process_patch(
  text: string,
  openFn: (p: string) => string,
  writeFn: (p: string, c: string) => void,
  removeFn: (p: string) => void,
): string {
  if (!text.startsWith(PATCH_PREFIX)) {
    throw new DiffError("Patch must start with *** Begin Patch\\n");
  }
  const paths = identify_files_needed(text);
  const orig = load_files(paths, openFn);
  const [patch, _fuzz] = text_to_patch(text, orig);
  const commit = patch_to_commit(patch, orig);
  apply_commit(commit, writeFn, removeFn);
  return "Done!";
}

// -----------------------------------------------------------------------------
// Default filesystem implementations
// -----------------------------------------------------------------------------

function open_file(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function write_file(p: string, content: string): void {
  if (path.isAbsolute(p)) {
    throw new DiffError("We do not support absolute paths.");
  }
  const parent = path.dirname(p);
  if (parent !== ".") {
    fs.mkdirSync(parent, { recursive: true });
  }
  fs.writeFileSync(p, content, "utf8");
}

function remove_file(p: string): void {
  fs.unlinkSync(p);
}
/**
 * Splits a full patch text into individual *** Begin/End Patch blocks.
 */
function split_patch_blocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split(/\r?\n/);
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith(PATCH_PREFIX)) {
      current = [line];
      continue;
    }
    if (current) {
      current.push(line);
      if (line.startsWith(PATCH_SUFFIX)) {
        blocks.push(current.join("\n"));
        current = null;
      }
    }
  }
  if (current) {
    throw new Error("Unterminated patch block");
  }
  return blocks;
}

// -----------------------------------------------------------------------------
// CLI mode. Not exported, executed only if run directly.
// -----------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  let patchText = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (patchText += chunk));
  process.stdin.on("end", () => {
    if (!patchText) {
      // eslint-disable-next-line no-console
      console.error("Please pass patch text through stdin");
      process.exit(1);
    }
    // Split into multiple patch blocks and apply each in sequence
    const blocks = split_patch_blocks(patchText);
    for (const block of blocks) {
      try {
        process_patch(block, open_file, write_file, remove_file);
      } catch (err: unknown) {
        // eslint-disable-next-line no-console
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }
    // eslint-disable-next-line no-console
    console.log("Done!");
  });
}

export const applyPatchToolInstructions = `
To edit files, ALWAYS use the \`shell\` tool with \`apply_patch\` CLI.  \`apply_patch\` effectively allows you to execute a diff/patch against a file, but the format of the diff specification is unique to this task, so pay careful attention to these instructions. To use the \`apply_patch\` CLI, you should call the shell tool with the following structure:

\`\`\`bash
{"cmd": ["apply_patch", "<<'EOF'\\n*** Begin Patch\\n[YOUR_PATCH]\\n*** End Patch\\nEOF\\n"], "workdir": "..."}
\`\`\`

Where [YOUR_PATCH] is the actual content of your patch, specified in the following V4A diff format.

*** [ACTION] File: [path/to/file] -> ACTION can be one of Add, Update, or Delete.
For each snippet of code that needs to be changed, repeat the following:
[context_before] -> See below for further instructions on context.
- [old_code] -> Precede the old code with a minus sign.
+ [new_code] -> Precede the new, replacement code with a plus sign.
[context_after] -> See below for further instructions on context.

For instructions on [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change’s [context_after] lines in the second change’s [context_before] lines.
- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs. For instance, we might have:
@@ class BaseClass
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

- If a code block is repeated so many times in a class or function such that even a single \`@@\` statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple \`@@\` statements to jump to the right context. For instance:

@@ class BaseClass
@@ 	def method():
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

Note, then, that we do not use line numbers in this diff format, as the context is enough to uniquely identify code. An example of a message that you might pass as "input" to this function, in order to apply a patch, is shown below.
 - The context lines (\`[context_before]\` and \`[context_after]\`) must match the target file exactly, including indentation, whitespace, and all characters. Git uses this context to locate and apply your patch; if the context does not match, the patch will fail to apply.

\`\`\`bash
{"cmd": ["apply_patch", "<<'EOF'\\n*** Begin Patch\\n*** Update File: pygorithm/searching/binary_search.py\\n@@ class BaseClass\\n@@     def search():\\n-        pass\\n+        raise NotImplementedError()\\n@@ class Subclass\\n@@     def search():\\n-        pass\\n+        raise NotImplementedError()\\n*** End Patch\\nEOF\\n"], "workdir": "..."}
\`\`\`

File references can only be relative, NEVER ABSOLUTE. After the apply_patch command is run, it will always say "Done!", regardless of whether the patch was successfully applied or not. However, you can determine if there are issue and errors by looking at any warnings or logging lines printed BEFORE the "Done!" is output.
`;
