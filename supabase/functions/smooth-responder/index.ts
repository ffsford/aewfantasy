import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function parsePurgeAt(raw: string): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const y = +m[1], mo = +m[2], day = +m[3], hh = +m[4], mm = +m[5], ss = +(m[6] || "0");
  return new Date(Date.UTC(y, mo - 1, day, hh + 4, mm, ss)); // Aug = EDT
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  try {
    const { data: settings } = await supabase.from("settings").select("key, value");
    const map: Record<string, string> = {};
    for (const row of settings || []) map[row.key] = row.value;

    const whenStr = map["next_purge_at"] || "";
    if (!whenStr) return json({ ok: true, skipped: true, reason: "No next_purge_at set" });

    const when = parsePurgeAt(whenStr);
    if (!when) return json({ ok: false, error: "Bad next_purge_at: " + whenStr }, 400);

    if (Date.now() < when.getTime()) {
      return json({
        ok: true,
        skipped: true,
        reason: "Deadline not reached yet",
        next_purge_at: whenStr,
        fire_at_utc: when.toISOString(),
      });
    }

    const { error: claimErr } = await supabase.from("purge_log").insert({
      scheduled_for: whenStr,
      ran_at: new Date().toISOString(),
    });
    if (claimErr) {
      if (
        claimErr.code === "23505" ||
        String(claimErr.message || "").toLowerCase().includes("duplicate")
      ) {
        return json({ ok: true, skipped: true, reason: "Already purged for this deadline" });
      }
      return json({ ok: false, error: "purge_log: " + claimErr.message }, 500);
    }

    const { data: teams, error: tErr } = await supabase
      .from("teams")
      .select("pin, name, division, points, purged, roster");
    if (tErr) return json({ ok: false, error: tErr.message }, 500);

    const lastPlace = (div: string) => {
      const list = (teams || [])
        .filter((t: any) => String(t.division || "").toLowerCase() === div && !t.purged)
        .sort(
          (a: any, b: any) =>
            (a.points || 0) - (b.points || 0) ||
            String(a.name || "").localeCompare(String(b.name || "")),
        );
      return list[0] || null;
    };

    const east = lastPlace("east");
    const west = lastPlace("west");
    const victims = [east, west].filter(Boolean);
    const names: string[] = [];

    for (const v of victims) {
      await supabase.from("teams").update({ roster: [], purged: true }).eq("pin", v.pin);
      names.push(`${v.division}:${v.name} (${v.points})`);
    }

    await supabase
      .from("purge_log")
      .update({ east_pin: east?.pin || null, west_pin: west?.pin || null })
      .eq("scheduled_for", whenStr);

    const msg =
      "RED ALERT: PURGE complete. " +
      names.join(" and ") +
      " have been removed. Their rosters are in free agency.";
    for (const t of teams || []) {
      if (t.pin && t.division) {
        await supabase.from("broadcasts").insert({
          from_pin: "system",
          target: t.pin,
          message: msg,
        });
      }
    }

    return json({ ok: true, purged: names, fire_at_utc: when.toISOString() });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});