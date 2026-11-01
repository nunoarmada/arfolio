import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) yield path;
  }
}

/** The text of every opening `<form ...>` tag, skipping the `>` of arrow functions inside `{}`. */
function formOpeningTags(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(/<form(?=[\s>])/g)) {
    let depth = 0;
    let end = match.index;
    for (; end < source.length; end++) {
      const c = source[end];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0 && source[end - 1] !== '=') break;
    }
    tags.push(source.slice(match.index, end + 1));
  }
  return tags;
}

describe('formOpeningTags', () => {
  it('finds the whole tag even when a handler contains an arrow function', () => {
    const tags = formOpeningTags(
      `<form className="a" onSubmit={(e) => { e.preventDefault(); }}>\n<input /></form>`,
    );
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('preventDefault');
    expect(tags[0]!.endsWith('}}>')).toBe(true);
  });

  it('ignores other elements that start with the same letters', () => {
    expect(formOpeningTags('<formatted /> <form-x />')).toEqual([]);
  });
});

// A form that only has a client-side submit handler is submitted natively when someone presses
// Enter before the page has hydrated. Without `method="post"` that is a GET: every field lands in
// the URL (amounts, names, and for the auth forms, passwords), in logs and in history.
describe('forms with a client submit handler', () => {
  it('declare method="post", so a pre-hydration submit never puts fields in the URL', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const tag of formOpeningTags(readFileSync(file, 'utf8'))) {
        if (/\bonSubmit=/.test(tag) && !/\bmethod=/.test(tag)) {
          offenders.push(relative(SRC, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
