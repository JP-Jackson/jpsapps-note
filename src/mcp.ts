/**
 * The MCP connector (NOTE_SPEC.md §8a).
 *
 * Claude connects from Anthropic's cloud, not from the phone in your pocket, so this
 * endpoint is public and authenticated by OAuth rather than by Cloudflare Access —
 * Access has no way to log a server in. The OAuth provider in index.ts verifies the
 * bearer token before anything here runs and hands us the user it belongs to.
 *
 * Deliberately hand-written JSON-RPC rather than the MCP SDK's server: Streamable
 * HTTP is a POST with a JSON-RPC body, and answering it statelessly avoids the
 * Durable Object a session-based server would need. §2 caps this project at
 * Cloudflare's free tiers, and a stateless Worker stays inside them.
 *
 * No SQL here. Every tool goes through Db, same as the rest of the app.
 */

import { applySpoken } from "./spoken";
import { worldOf } from "./db";
import { Db, type SubjectRow } from "./db";
import { VERSION } from "./version";
import { utcDay } from "./ids";

const PROTOCOL_VERSION = "2025-06-18";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type Json = Record<string, unknown>;

const ok = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: RpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** Tool results are text; Claude reads them, so favour readable over machine-tidy. */
const text = (s: string) => ({ content: [{ type: "text", text: s }] });

/**
 * A tool that could not do what was asked.
 *
 * Reported as a result with isError rather than a JSON-RPC error, per the MCP spec:
 * the model can read it and try again, where a protocol error just ends the turn.
 */
const problem = (s: string) => ({ ...text(s), isError: true });

const TOOLS = [
  {
    name: "search_notes",
    description:
      "Search the log for notes containing some text. Searches both the current wording " +
      "and the original dictation, so a word removed by an edit is still findable.",
    inputSchema: {
      type: "object",
      properties: {
        context: {
          type: "string", enum: ["work", "personal"],
          description: "Which world: work or personal. They never mix. If the user has " +
            "not made it clear which one they mean, ASK before calling.",
        },
        query: { type: "string", description: "Text to look for" },
        limit: { type: "number", description: "Maximum results (default 25)" },
      },
      required: ["context", "query"],
    },
  },
  {
    name: "get_day",
    description: "Everything logged on one day. Use for questions like 'what did I do on Tuesday'.",
    inputSchema: {
      type: "object",
      properties: {
        context: {
          type: "string", enum: ["work", "personal"],
          description: "Which world: work or personal. They never mix. If the user has " +
            "not made it clear which one they mean, ASK before calling.",
        },
        date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["context", "date"],
    },
  },
  {
    name: "list_open_items",
    description:
      "Unresolved follow-ups, oldest first — the things still outstanding.",
    inputSchema: { type: "object", properties: {
        context: {
          type: "string", enum: ["work", "personal"],
          description: "Which world: work or personal. They never mix. If the user has " +
            "not made it clear which one they mean, ASK before calling.",
        },
      }, required: ["context"] },
  },
  {
    name: "list_things",
    description:
      "The items being tracked: equipment, vehicles and anything else with a history.",
    inputSchema: { type: "object", properties: {
        context: {
          type: "string", enum: ["work", "personal"],
          description: "Which world: work or personal. They never mix. If the user has " +
            "not made it clear which one they mean, ASK before calling.",
        },
      }, required: ["context"] },
  },
  {
    name: "get_thing",
    description:
      "One thing with its details and its full history. Use this before diagnosing a " +
      "recurring fault — the last fix is usually already recorded here.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name or id of the item" },
        context: {
          type: "string", enum: ["work", "personal"],
          description: "Which world: work or personal. They never mix. If the user has " +
            "not made it clear which one they mean, ASK before calling.",
        },
      },
      required: ["name", "context"],
    },
  },
  {
    name: "add_thing",
    description:
      "Add something to track. Attributes are free-form key/value pairs — only include " +
      "fields actually known.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: { type: "string", enum: ["equipment", "vehicle", "generic"] },
        context: { type: "string", enum: ["work", "personal"] },
        attributes: { type: "object", description: 'e.g. {"Make": "Ingersoll Rand"}' },
        inside: {
          type: "string",
          description:
            "Name of a place or another thing this lives in, e.g. 'Yard'. Things nest: " +
            "Home > Yard > Front sprinkler.",
        },
      },
      required: ["name", "context"],
    },
  },
  {
    name: "add_note",
    description:
      "Log a note. Use this to record what was found or fixed, so it is in the thing's " +
      "history next time.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string" },
        context: { type: "string", enum: ["work", "personal"] },
        thing: { type: "string", description: "Name of a thing to attach it to" },
        needs_followup: { type: "boolean" },
      },
      required: ["body", "context"],
    },
  },
];

/**
 * Resolve a thing by id, then by exact name, then by a partial match.
 *
 * An ambiguous partial match returns the candidates instead of picking one. Two
 * compressors in a shop is the normal case, not the edge case, and quietly handing
 * back the wrong one's history is worse than answering with a question — the whole
 * point of the history is diagnosing against the right machine.
 */
type Found =
  | { thing: SubjectRow; choices?: never }
  | { thing?: never; choices: SubjectRow[] };

async function findThing(db: Db, needle: string): Promise<Found> {
  const all = await db.listSubjects(true);
  const lower = needle.trim().toLowerCase();

  const exact = all.find((s) => s.id === needle) || all.find((s) => s.name.toLowerCase() === lower);
  if (exact) return { thing: exact };

  // No tie-break beyond this. Preferring, say, the name that starts with the word
  // would have "compressor" quietly resolve to "Compressor 2" over "Shop Air
  // Compressor" — a rule that looks like cleverness and is really just a guess with
  // extra steps. One match answers; anything else asks.
  const partial = all.filter((s) => s.name.toLowerCase().includes(lower));
  return partial.length === 1 ? { thing: partial[0]! } : { choices: partial };
}

/** How the ambiguous and empty cases read back to Claude. */
function ambiguity(needle: string, choices: SubjectRow[]): string {
  if (!choices.length) return `Nothing tracked matches "${needle}".`;
  return (
    `"${needle}" matches ${choices.length} things — which one?\n` +
    choices.map((s) => `  ${s.name} (${s.type}, ${s.context})`).join("\n")
  );
}

const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

function listNotes(rows: { created_at: number; context: string; body: string | null; is_open: number }[]) {
  if (!rows.length) return "Nothing found.";
  return rows
    .map((e) => `${when(e.created_at)}  [${e.context}${e.is_open ? " · open" : ""}] ${e.body ?? "(photo)"}`)
    .join("\n");
}

async function callTool(db: Db, name: string, args: Json): Promise<{ content: unknown[]; isError?: boolean }> {
  // Every tool names a world. Without one the answer would either merge the two
  // sides or silently pick one; either is wrong, so the tool asks instead.
  const world = worldOf(typeof args.context === "string" ? args.context : null);
  if (!world) return problem("Which world — work or personal? Ask the user, then call again with context.");
  db.world = world;
  switch (name) {
    case "search_notes": {
      const q = String(args.query ?? "").trim();
      if (q.length < 2) return problem("Give me at least two characters to search for.");
      const rows = await db.searchEntries(q, Math.min(Number(args.limit) || 25, 50));
      return text(`${rows.length} match${rows.length === 1 ? "" : "es"} for "${q}":\n\n${listNotes(rows)}`);
    }

    case "get_day": {
      const date = String(args.date ?? utcDay());
      const start = Date.parse(`${date}T00:00:00`);
      if (Number.isNaN(start)) return problem(`"${date}" is not a date I can read. Use YYYY-MM-DD.`);
      const rows = await db.entriesForDay(start, start + 86_400_000);
      return text(`${date}: ${rows.length} entr${rows.length === 1 ? "y" : "ies"}\n\n${listNotes(rows)}`);
    }

    case "list_open_items": {
      const rows = await db.openEntries(100);
      return text(
        rows.length
          ? `${rows.length} open, oldest first:\n\n${listNotes(rows)}`
          : "Nothing open. All caught up.",
      );
    }

    case "list_things": {
      const rows = await db.listSubjects();
      if (!rows.length) return text("Nothing tracked yet.");
      // Things nest now, so a flat list of names loses the one fact that separates
      // the rental's air conditioner from the house's. Resolved once here from the
      // rows already fetched, rather than a query per thing.
      const places = await db.listPlaces();
      const byId = new Map(rows.map((s) => [s.id, s]));
      const placeName = new Map(places.map((p) => [p.id, p.name]));
      const pathOf = (s: SubjectRow): string => {
        const above: string[] = [];
        let at = s.parent_id ? byId.get(s.parent_id) : undefined;
        for (let i = 0; at && i < 32; i++) {
          above.unshift(at.name);
          at = at.parent_id ? byId.get(at.parent_id) : undefined;
        }
        // The root's place, if it has one, heads the path.
        let root: SubjectRow | undefined = s;
        for (let i = 0; root?.parent_id && i < 32; i++) root = byId.get(root.parent_id);
        const place = root?.place_id ? placeName.get(root.place_id) : undefined;
        if (place) above.unshift(place);
        return above.length ? above.join(" > ") + " > " : "";
      };
      return text(rows.map((s) => `${pathOf(s)}${s.name} — ${s.type}, ${s.context}`).join("\n"));
    }

    case "get_thing": {
      const needle = String(args.name ?? "");
      const found = await findThing(db, needle);
      if (!found.thing) return problem(ambiguity(needle, found.choices));
      const d = await db.subjectDetail(found.thing.id);
      if (!d) return problem("That thing has gone missing.");
      const attrs = d.attributes.length
        ? d.attributes.map((a) => `  ${a.key}: ${a.value ?? "—"}`).join("\n")
        : "  (nothing recorded)";
      const lives = d.path.length ? `Lives in: ${d.path.map((c) => c.name).join(" > ")}\n` : "";
      const parts = d.children.length
        ? `\nParts (${d.children.length}):\n${d.children.map((k) => `  ${k.name}`).join("\n")}\n`
        : "";
      return text(
        `${d.name} — ${d.type}, ${d.context}\n${lives}${parts}\nDetails:\n${attrs}\n\n` +
          `History (${d.entries.length}):\n${listNotes(d.entries)}`,
      );
    }

    case "add_thing": {
      const name = String(args.name ?? "").trim();
      const context = String(args.context ?? "").trim();
      if (!name || !context) return problem("A thing needs a name and a context.");
      // "inside" is one word from Claude and could mean either kind of container,
      // so both are searched. A thing wins a tie: a place named Yard and a thing
      // named Yard is a naming problem the user already has, and putting the
      // sprinkler under the thing keeps the branch they built intact.
      let parentId: string | null = null;
      let placeId: string | null = null;
      const inside = String(args.inside ?? "").trim();
      if (inside) {
        const found = await findThing(db, inside);
        if (found.thing) parentId = found.thing.id;
        else {
          const place = (await db.listPlaces())
            .find((p) => p.name.toLowerCase() === inside.toLowerCase());
          if (place) placeId = place.id;
          else return problem(`Nothing called "${inside}" to put it in.`);
        }
      }
      const made = await db.createSubject({
        name,
        type: String(args.type ?? "generic"),
        context,
        parent_id: parentId,
        place_id: placeId,
      });
      const attrs = (args.attributes ?? {}) as Record<string, unknown>;
      const list = Object.entries(attrs).map(([key, value], i) => ({
        key,
        value: value == null ? null : String(value),
        sort_order: i,
      }));
      if (list.length) await db.setAttributes(made.id, list);
      // Reported from what was stored, not what was asked for — the two differ
      // whenever a context or type was normalised on the way in.
      return text(
        `Added "${name}" (${made.type}, ${made.context})` +
          `${inside ? ` inside ${inside}` : ""}` +
          `${list.length ? ` with ${list.length} field${list.length === 1 ? "" : "s"}` : ""}.`,
      );
    }

    case "add_note": {
      const body = String(args.body ?? "").trim();
      const context = String(args.context ?? "").trim();
      if (!body || !context) return problem("A note needs some text and a context.");
      // The id is generated here for the same reason the phone generates its own:
      // the write is then idempotent and a retry cannot duplicate it.
      const id = crypto.randomUUID();
      await db.createEntry({
        id,
        created_at: Date.now(),
        context,
        body,
        lat: null,
        lng: null,
        is_open: args.needs_followup === true,
      });
      // "New item X" spoken through Claude works the same as from the phone.
      const made = await applySpoken(db, body, context, null);
      await db.linkEntrySubjects(id, made.subject_ids);
      await db.linkEntryPeople(id, made.person_ids);
      // The note is written either way. Losing a capture because the thing name was
      // ambiguous would be the one unforgivable failure (§1); say so and move on.
      if (args.thing) {
        const needle = String(args.thing);
        const found = await findThing(db, needle);
        if (found.thing) {
          await db.linkEntrySubjects(id, [found.thing.id]);
          return text(`Logged against ${found.thing.name}.`);
        }
        return text(`Logged, but not attached to anything.\n\n${ambiguity(needle, found.choices)}`);
      }
      return text("Logged.");
    }

    default:
      return problem(`No tool called "${name}".`);
  }
}

/**
 * Handle one Streamable HTTP request.
 *
 * `userId` comes from the OAuth token the provider already verified, so every tool
 * runs against a Db scoped to that user — the same guarantee the web app has.
 */
export async function handleMcp(request: Request, d1: D1Database, userId: string): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("MCP endpoint — POST JSON-RPC here.", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  let body: RpcRequest | RpcRequest[];
  try {
    body = (await request.json()) as RpcRequest | RpcRequest[];
  } catch {
    return Response.json(fail(null, -32700, "Parse error"), { status: 400 });
  }

  const db = new Db(d1, userId);
  const one = async (req: RpcRequest): Promise<unknown | null> => {
    switch (req.method) {
      case "initialize":
        return ok(req.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "note", version: VERSION },
        });

      // Notifications carry no id and must not be answered.
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;

      case "ping":
        return ok(req.id, {});

      case "tools/list":
        return ok(req.id, { tools: TOOLS });

      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const args = (req.params?.arguments ?? {}) as Json;
        try {
          return ok(req.id, await callTool(db, name, args));
        } catch (e) {
          // Report a failed tool as a result, not a protocol error: the model can
          // read it and try something else, where an error just ends the turn.
          return ok(req.id, {
            ...text(`That failed: ${e instanceof Error ? e.message : "unknown error"}`),
            isError: true,
          });
        }
      }

      default:
        return fail(req.id, -32601, `Method not found: ${req.method}`);
    }
  };

  const replies = Array.isArray(body)
    ? (await Promise.all(body.map(one))).filter((r) => r !== null)
    : await one(body);

  // A notification-only request gets 202 with no body, per the transport spec.
  if (replies === null || (Array.isArray(replies) && replies.length === 0)) {
    return new Response(null, { status: 202 });
  }

  const res = Response.json(replies);
  db.addNeurons(0);
  await db.flushUsage();   // the meter counts what Claude costs too
  return res;
}
