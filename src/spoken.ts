/**
 * Spoken commands inside a note.
 *
 * "New item Compressor 3. Tripping on start." adds Compressor 3 and links the note
 * to it. "New person Bob Reyes, lease operator at Baker" adds Bob. Handled on the
 * server rather than the phone so the same sentence works from a queued offline
 * capture, from the web app, and from Claude through the connector — and so a
 * capture never waits on a second request.
 *
 * The body is left exactly as dictated. Stripping the command would make the note
 * read differently from what was said, and body_raw is supposed to be the original.
 */
import type { Db } from "./db";

export interface Spoken {
  items: string[];
  people: string[];
}

// "new item X", "add item X", "new person X". The name runs to the end of the
// sentence: a period, comma, semicolon, newline, or " - ". Case-insensitive.
const RE = /\b(?:new|add)\s+(item|person)\s*[:\-]?\s+([^.,;\n]+?)(?=\s+-\s|[.,;\n]|$)/gi;

export function parseSpoken(body: string | null | undefined): Spoken {
  const out: Spoken = { items: [], people: [] };
  if (!body) return out;
  for (const m of body.matchAll(RE)) {
    const name = (m[2] || "").trim();
    if (!name) continue;
    (m[1]!.toLowerCase() === "item" ? out.items : out.people).push(name);
  }
  return out;
}

export interface Applied {
  subject_ids: string[];
  person_ids: string[];
}

/**
 * Create what the note asked for and return the ids to link. An existing record
 * with the same name is linked rather than duplicated — saying "new item" about
 * something already tracked is the most likely way to say its name in the field.
 */
export async function applySpoken(
  db: Db,
  body: string | null | undefined,
  context: string,
  placeId: string | null,
): Promise<Applied> {
  const found = parseSpoken(body);
  const out: Applied = { subject_ids: [], person_ids: [] };
  for (const name of found.items) {
    const have = await db.subjectByName(name);
    if (have) { out.subject_ids.push(have.id); continue; }
    // Work is mostly machines; home is mostly not. Either is one tap to change.
    const type = context === "work" ? "equipment" : "generic";
    const { id } = await db.createSubject({ name, type, context, place_id: placeId });
    out.subject_ids.push(id);
  }
  for (const name of found.people) {
    const have = await db.personByName(name);
    if (have) { out.person_ids.push(have.id); continue; }
    const id = await db.createPerson({ name, context, place_ids: placeId ? [placeId] : [] });
    out.person_ids.push(id);
  }
  return out;
}
