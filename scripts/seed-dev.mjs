// Seed a realistic WORK-side data set. Two modes:
//   NOTE_URL=http://127.0.0.1:8787 node scripts/seed-dev.mjs          -> through the API, local dev
//   node scripts/seed-dev.mjs --sql USER_ID > seed.sql                  -> SQL for wrangler d1 execute --remote
// Coordinates are invented (west Texas). Fake data: delete it when done with it.
const SQL_USER = process.argv[2] === "--sql" ? process.argv[3] : null;
const URL_ = process.env.NOTE_URL || "http://127.0.0.1:8787";
const out = [];
const q = (v) => v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
const ins = (table, row) =>
  out.push(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`);
const api = async (m, p, b) => {
  if (SQL_USER) return sqlApi(p, b);
  const r = await fetch(URL_ + p, { method: m, headers: { "content-type": "application/json" }, body: b && JSON.stringify(b) });
  if (!r.ok) throw new Error(m + " " + p + " " + r.status + " " + (await r.text()));
  return r.json();
};
// The same calls, written as rows. Mirrors what the routes do, minus validation.
function sqlApi(p, b) {
  const id = b.id || crypto.randomUUID(), now = Date.now();
  if (p === "/api/places") ins("places", { id, user_id: SQL_USER, name: b.name, lat: b.lat, lng: b.lng, radius_m: b.radius_m || 150, created_at: now });
  else if (p === "/api/subjects") {
    ins("subjects", { id, user_id: SQL_USER, name: b.name, type: b.type, context: b.context, visibility: "private",
      created_at: now, parent_id: b.parent_id || null, place_id: b.parent_id ? null : (b.place_id || null) });
    (b.attributes || []).forEach((a) => ins("subject_attributes", { subject_id: id, user_id: SQL_USER, key: a.key, value: a.value, sort_order: a.sort_order }));
  } else if (p === "/api/people") {
    ins("people", { id, user_id: SQL_USER, name: b.name, role: b.role || null, company: b.company || null, phone: b.phone || null,
      email: b.email || null, notes: b.notes || null, context: b.context, created_at: now });
    (b.place_ids || []).forEach((pid) => ins("person_places", { person_id: id, place_id: pid, user_id: SQL_USER }));
  } else if (p === "/api/entries") {
    const kind = b.kind || (b.is_open ? "todo" : "note");
    ins("entries", { id, user_id: SQL_USER, created_at: b.created_at, synced_at: now, context: b.context, body: b.body, body_raw: b.body,
      lat: null, lng: null, is_open: kind === "todo" && !b.done_at ? 1 : 0, place_id: b.place_id || null, version: 1,
      kind, due_at: b.due_at || null, done_at: b.done_at || null, starts_at: b.starts_at || null, ends_at: b.ends_at || null,
      metric: b.metric || null, value: b.value ?? null, unit: b.unit || null, spec_key: b.spec_key || null, spec_value: b.spec_value || null,
      reviewed: b.reviewed === false ? 0 : 1 });
    (b.subject_ids || []).forEach((sid) => ins("entry_subjects", { entry_id: id, subject_id: sid, user_id: SQL_USER }));
    (b.person_ids || []).forEach((pid) => ins("entry_people", { entry_id: id, person_id: pid, user_id: SQL_USER }));
    (b.tags || []).forEach((t) => {
      const tid = (TAGS[t] = TAGS[t] || crypto.randomUUID());
      if (!TAGS["_" + t]) { TAGS["_" + t] = 1; ins("tags", { id: tid, user_id: SQL_USER, name: t, created_at: now }); }
      ins("entry_tags", { entry_id: id, tag_id: tid, user_id: SQL_USER, suggested: 0 });
    });
  } else if (p === "/api/schedules") {
    ins("schedules", { id, user_id: SQL_USER, subject_id: b.subject_id || null, context: b.context, label: b.label,
      every_days: b.every_days ?? null, every_value: b.every_value ?? null, metric: b.metric || null,
      fixed_month: b.fixed_month ?? null, fixed_day: b.fixed_day ?? null, last_done_at: b.last_done_at ?? null,
      last_value: b.last_value ?? null, created_at: now });
  }
  return { id };
}
const TAGS = {};
const day = 86400000, now = Date.now();
const at = (daysAgo, h, mi = 0) => { const d = new Date(now - daysAgo * day); d.setHours(h, mi, 0, 0); return d.getTime(); };

// ---- places
const P = {};
for (const [name, lat, lng, r, ctx] of [
  ["Shop", 31.9973, -102.0779, 150],
  ["Office", 31.9910, -102.0650, 120],
  ["Baker Lease", 32.2101, -102.3312, 400],
  ["Smith Battery", 31.8422, -101.9017, 300],
  ["Rental", 32.4710, -102.2201, 250, "personal"],
]) P[name] = (await api("POST", "/api/places", { name, lat, lng, radius_m: r, context: ctx || "work" })).id;

// ---- things (subjects)
const S = {};
const thing = async (name, type, attrs = [], home = {}) => {
  S[name] = (await api("POST", "/api/subjects", { name, type, context: "work",
    attributes: attrs.map(([key, value], i) => ({ key, value, sort_order: i })), ...home })).id;
};
await thing("Compressor 2", "equipment", [["Make", "Ingersoll Rand"], ["Model", "IR-2475N7.5"], ["Voltage", "480V 3ph"], ["Oil", "T30 Select"]], { place_id: P.Shop });
await thing("Compressor 2 starter", "equipment", [["Contactor", "Allen-Bradley 100-C23"], ["Overload", "193-EECB"]], { parent_id: S["Compressor 2"] });
await thing("Baker tank battery", "equipment", [["PLC", "CompactLogix 5069-L306ER"], ["RTU", "Red Lion DA30"], ["Radio", "Cal-Amp Viper SC+"]], { place_id: P["Baker Lease"] });
await thing("Baker LACT unit", "equipment", [["Meter", "Coriolis Micro Motion 2700"], ["Modbus ID", "3"], ["Baud", "9600 8N1"]], { parent_id: S["Baker tank battery"] });
await thing("Baker VFD — transfer pump", "equipment", [["Make", "ABB ACS580"], ["HP", "30"], ["Fault history", "F0001 overcurrent x3"]], { parent_id: S["Baker tank battery"] });
await thing("Smith Battery RTU", "equipment", [["Make", "Red Lion Crimson 3.2"], ["Poll", "Cygnet 60s"]], { place_id: P["Smith Battery"] });
await thing("Cygnet server", "equipment", [["Host", "SCADA-01"], ["Version", "9.2"], ["Backup", "nightly to NAS"]], { place_id: P.Office });
await thing("F-150", "vehicle", [["Year", "2021"], ["Oil", "5W-30 full synthetic"], ["Tires", "275/65R18"], ["Next service", "142,000"]], { place_id: P.Shop });
await thing("Fluke 87V", "equipment", [["Cal due", "Mar 2027"]], { place_id: P.Shop });
// ---- people: their own records, at one or more places
const H = {};
const person = async (name, fields, placeNames) => {
  H[name] = (await api("POST", "/api/people", { name, context: "work", ...fields,
    place_ids: placeNames.map((n) => P[n]) })).id;
};
await person("Bob Reyes", { role: "Lease operator", company: "Permian Ops", phone: "432-555-0147", notes: "Baker startup, 2024. Knows the site cold." }, ["Baker Lease"]);
await person("Dana Whitfield", { role: "Foreman", company: "Permian Ops", phone: "432-555-0192", notes: "Wants texts, not calls." }, ["Smith Battery", "Baker Lease"]);
await person("Kyle Mendez", { role: "Drives support", company: "ABB", email: "kyle.m@abb-support.example", notes: "Case CS-88213 on the Baker VFD." }, []);

// ---- notes: [daysAgo, hour, body, place, subjects[], open, extra]
// extra is the v2 shape: kind, tags, due, metric/value, spec. Left off, it is a note.
const N = [
  [29, 8, "Started day at shop. Comp 2 tripping on startup again, third time this month.", "Shop", ["Compressor 2"], false],
  [29, 9, "Pulled starter cover. Contactor contacts pitted, overload not tripped. Ordering 100-C23.", "Shop", ["Compressor 2 starter"], true, { tags: ["parts"], due: 27 }],
  [28, 10, "Baker: transfer pump VFD F0001 on start. Bob says it happens when tank is above 80%.", "Baker Lease", ["Baker VFD — transfer pump", "Bob Reyes"], true],
  [28, 11, "LACT Coriolis reading 0 flow with pump running. Modbus ID 3, checked with Modscan — registers respond, float byte order looks swapped.", "Baker Lease", ["Baker LACT unit"], true],
  [27, 14, "Called ABB. Kyle opened case CS-88213. Suggested raising accel time 5s→15s and checking motor cable length.", "Office", ["Baker VFD — transfer pump", "Kyle Mendez"], false],
  [26, 9, "Set accel 15s on Baker VFD. Ran three starts at 85% tank, no fault.", "Baker Lease", ["Baker VFD — transfer pump"], false],
  [26, 10, "LACT: swapped float word order in DA30 tag config. Flow now matches ticket. Closed.", "Baker Lease", ["Baker LACT unit"], false],
  [24, 8, "Contactor arrived. Swapped, torqued, ran comp 2 through five starts. Clean.", "Shop", ["Compressor 2 starter"], false],
  [22, 13, "Smith: Dana says RTU dropping off Cygnet overnight. Crimson log shows link timeout 02:00–02:40.", "Smith Battery", ["Smith Battery RTU", "Dana Whitfield"], true],
  [21, 15, "Cygnet server: nightly backup job runs 02:00 and pegs disk. Suspect that's Smith's timeout window.", "Office", ["Cygnet server", "Smith Battery RTU"], false],
  [20, 8, "Moved Cygnet backup to 03:30. Watch Smith for a week.", "Office", ["Cygnet server"], true],
  [18, 12, "Truck: oil change at 137,220. Next at 142k.", "Shop", ["F-150"], false, { tags: ["maintenance"] }],
  [18, 12, "odo 137220", "Shop", ["F-150"], false, { kind: "value", metric: "odo", value: 137220, unit: "mi" }],
  [9, 18, "odo 138410", "Shop", ["F-150"], false, { kind: "value", metric: "odo", value: 138410, unit: "mi" }],
  [2, 18, "odo 139350", "Shop", ["F-150"], false, { kind: "value", metric: "odo", value: 139350, unit: "mi" }],
  [12, 9, "Comp 2 discharge temp 212F after the cooler wash", "Shop", ["Compressor 2"], false, { kind: "value", metric: "temp", value: 212, unit: "F", tags: ["vibration"] }],
  [11, 9, "Firmware 3.2.0104 on the Smith RTU after the update", "Smith Battery", ["Smith Battery RTU"], false, { kind: "spec", spec_key: "Firmware", spec_value: "3.2.0104" }],
  [5, 10, "Cygnet call with Weatherford on Smith polling", "Office", ["Smith Battery RTU"], false, { kind: "appt", starts: 2, tags: ["cygnet"] }],
  [4, 15, "Check Modbus poll rate on Smith RTU, Dana says 5s is too fast", "Office", ["Smith Battery RTU", "Dana Whitfield"], true, { tags: ["cygnet", "modbus"], due: -1 }],
  [6, 8, "Rebuild Cygnet alarm group for Baker", "Office", ["Cygnet server"], false, { kind: "todo", tags: ["cygnet"], due: -3, done: -3 }],
  [1, 21, "remember to ask about the antenna boot lead time", "Baker Lease", [], false, { reviewed: false }],
  [15, 9, "Rental: no signal at all in the pump house. Could not open Note to read comp history. Wrote it on my hand.", "Rental", [], false],
  [14, 10, "Smith stable 7 nights. Dana confirmed. Closing.", "Smith Battery", ["Smith Battery RTU", "Dana Whitfield"], false],
  [10, 16, "Baker: Bob mentioned the radio drops when it rains. Look at antenna connector next visit.", "Baker Lease", ["Baker tank battery", "Bob Reyes"], true],
  [7, 9, "Fluke 87V reading 2V low on 480. Send for cal.", "Shop", ["Fluke 87V"], true],
  [3, 8, "Comp 2 started fine after cold night. Contactor fix holding.", "Shop", ["Compressor 2"], false],
  [1, 14, "Baker antenna N-connector had water in it. Dried, taped, new boot on order.", "Baker Lease", ["Baker tank battery"], true],
  [0, 8, "Shop: parts run for VFD boot, then Smith after lunch.", "Shop", [], false],
];
let n = 0;
for (const [d, h, body, place, subs, open, x = {}] of N) {
  const kind = x.kind || (open ? "todo" : "note");
  await api("POST", "/api/entries", { id: crypto.randomUUID(), created_at: at(d, h, n % 50), context: "work",
    body, place_id: P[place], is_open: open, kind,
    due_at: x.due != null ? at(-x.due, 9) : null,
    done_at: x.done != null ? at(-x.done, 16) : null,
    starts_at: x.starts != null ? at(-x.starts, 10) : null, ends_at: x.starts != null ? at(-x.starts, 11) : null,
    metric: x.metric || null, value: x.value ?? null, unit: x.unit || null,
    spec_key: x.spec_key || null, spec_value: x.spec_value || null,
    tags: x.tags || [], reviewed: x.reviewed !== false,
    subject_ids: subs.filter((s) => S[s]).map((s) => S[s]),
    person_ids: subs.filter((s) => H[s]).map((s) => H[s]) });
  n++;
}
// ---- schedules: rules on things, by date, by reading, or a yearly date
await api("POST", "/api/schedules", { context: "work", subject_id: S["F-150"], label: "Oil change", every_days: 180, every_value: 5000, metric: "odo", last_done_at: at(18, 12), last_value: 137220 });
await api("POST", "/api/schedules", { context: "work", subject_id: S["Compressor 2"], label: "Oil sample to lab", every_days: 30, last_done_at: at(12, 9) });
await api("POST", "/api/schedules", { context: "work", subject_id: S["Fluke 87V"], label: "Calibration", fixed_month: 3, fixed_day: 1 });
await api("POST", "/api/schedules", { context: "work", subject_id: S["Cygnet server"], label: "Test restore from backup", every_days: 90, last_done_at: at(95, 9) });
// One spoken command, so the seed proves the path the phone will use. SQL mode has
// no server to parse it, so the item is made by hand there.
const dryer = SQL_USER ? [(await api("POST", "/api/subjects", { name: "Shop air dryer", type: "equipment", context: "work", place_id: P.Shop })).id] : [];
await api("POST", "/api/entries", { id: crypto.randomUUID(), created_at: at(0, 9, 5), context: "work",
  body: "New item Shop air dryer. Drain valve stuck open, cycling every 30s.", place_id: P.Shop, subject_ids: dryer });
if (SQL_USER) { console.log(out.join("\n")); process.exit(0); }
console.log("seeded", Object.keys(P).length, "places,", Object.keys(S).length + 1, "items,", Object.keys(H).length, "people,", n + 1, "notes");
