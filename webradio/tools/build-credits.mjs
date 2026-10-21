#!/usr/bin/env node
/**
 * Credits builder — rewrites the "Guest songs & instrumentals" section of
 * CREDITS.md straight from data/library.json, so the page can never credit a
 * track that is no longer on the shelf (or forget one that is).
 *
 *   node tools/build-credits.mjs        # after editing library.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(new URL('../data/library.json', import.meta.url), 'utf8'));
const CREDITS = new URL('../CREDITS.md', import.meta.url);
const HEADING = '## Guest songs & instrumentals';

const body = (DATA.freeTracks || []).map((t) => {
  const license = t.license || 'CC BY 3.0';
  return [
    `- **${t.title}** — ${t.artist}. ${license}. ${t.credit || `${t.title} by ${t.artist}`}`,
    `  ${t.licenseUrl} · ${t.source}`
  ].join('\n');
}).join('\n');

const section = `${HEADING}

The following tracks by independent artists are hosted on this site under
Creative Commons Attribution licences (CC BY). Each entry credits its author and
links back to the original upload; the licence permits commercial and
non-commercial reuse with attribution.
They appear in the live rotation and in the library alongside the original catalogue.

${body}
`;

const current = readFileSync(CREDITS, 'utf8');
const start = current.indexOf(HEADING);
if (start === -1) throw new Error(`CREDITS.md has no "${HEADING}" heading`);

/* Everything from the heading up to the next top-level section stays as it is. */
const nextSection = current.indexOf('\n## ', start + HEADING.length);
const tail = nextSection === -1 ? '' : current.slice(nextSection + 1);

writeFileSync(CREDITS, `${current.slice(0, start)}${section}${tail ? `\n${tail}` : ''}`);
console.log(`credits: ${DATA.freeTracks.length} guest tracks`);
