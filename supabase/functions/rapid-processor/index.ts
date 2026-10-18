import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Division keys for this season, mirroring getDivisionSetup() / getLeagueDivisions() in
// app.js: settings.division_setup in order; when it is not set, the divisions the teams
// are in (east + west -> exactly ["east", "west"], the original behavior).
function leagueDivisions(
  rawSetup: string | undefined,
  teams: any[],
): { slugs: string[]; count: number } {
  let setup: any = null;
  try {
    setup = rawSetup ? JSON.parse(rawSetup) : null;
  } catch {
    setup = null;
  }
  if (setup && Number(setup.count) >= 1 && Array.isArray(setup.names) && setup.names.length) {
    const out: string[] = [];
    for (const n of setup.names) {
      const slug = String(n?.slug || "").trim();
      if (slug && !out.includes(slug)) out.push(slug);
    }
    if (out.length) return { slugs: out, count: Number(setup.count) };
  }
  const slugs = [...new Set(teams.map((t: any) => t.division).filter(Boolean))] as string[];
  if (slugs.includes("east") && slugs.includes("west")) return { slugs: ["east", "west"], count: 2 };
  if (slugs.length >= 1) return { slugs: slugs.sort(), count: slugs.length };
  return { slugs: ["east", "west"], count: 2 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: deadlineRow } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "waiver_deadline")
      .maybeSingle();

    if (!deadlineRow?.value) {
      return json({ ok: true, skipped: true, reason: "No waiver deadline set" });
    }

    const deadline = new Date(deadlineRow.value);
    if (isNaN(deadline.getTime()) || Date.now() < deadline.getTime()) {
      return json({
        ok: true,
        skipped: true,
        reason: "Deadline not reached yet",
        deadline: deadlineRow.value,
      });
    }

    const { data: lastProc } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "last_processed_deadline")
      .maybeSingle();

    if (lastProc?.value === deadlineRow.value) {
      return json({
        ok: true,
        skipped: true,
        reason: "Already processed this deadline",
      });
    }

    const { data: teams } = await supabase.from("teams").select("*");
    const { data: claims } = await supabase.from("claims").select("*");
    const { data: masterRows } = await supabase
      .from("master_roster")
      .select("name");
    const { data: dropSettings } = await supabase
      .from("settings")
      .select("key, value")
      .like("key", "claim_drops_%");

    const dropFromSettings: Record<string, { drop?: string; drops?: string[] }> =
      {};
    (dropSettings || []).forEach((row: any) => {
      const pin = String(row.key || "").replace(/^claim_drops_/, "");
      try {
        dropFromSettings[pin] =
          typeof row.value === "string" ? JSON.parse(row.value) : row.value;
      } catch {
        /* ignore */
      }
    });

    const users: Record<string, any> = {};
    const points: Record<string, number> = {};
    (teams || []).forEach((t: any) => {
      users[t.pin] = {
        name: t.name,
        division: t.division,
        roster: t.roster || [],
        maxRoster: t.max_roster || 8,
        purged: !!t.purged,
        isCommissioner: !!t.is_commissioner,
      };
      points[t.pin] = t.points || 0;
    });

    const claimMap: Record<string, any> = {};
    (claims || []).forEach((c: any) => {
      const extra = dropFromSettings[c.pin] || {};
      claimMap[c.pin] = {
        ranked: c.ranked || [],
        drop: c.drop || extra.drop || null,
        drops:
          c.drops ||
          extra.drops ||
          (c.drop || extra.drop ? [c.drop || extra.drop] : []),
      };
    });

    const master = (masterRows || []).map((r: any) => r.name);

    // Divisions (settings.division_setup, else east/west) and roster mode, mirroring
    // getLeagueDivisions() / isSharedRosterPool() / processWaivers() in app.js.
    const { data: modeSettings } = await supabase
      .from("settings")
      .select("key, value")
      .in("key", ["division_setup", "roster_mode"]);
    const modeMap: Record<string, string> = {};
    (modeSettings || []).forEach((row: any) => (modeMap[row.key] = row.value));
    const league = leagueDivisions(modeMap["division_setup"], teams || []);
    // One division is always one shared AEW roster.
    const shared = league.count === 1 || modeMap["roster_mode"] === "shared";

    function available(div: string) {
      const taken = new Set<string>();
      Object.values(users).forEach((u: any) => {
        // Shared roster: a wrestler on ANY team is taken. Separate: only this division.
        if (shared || (u.division === div && !u.purged)) {
          (u.roster || []).forEach((w: string) =>
            taken.add(String(w).toLowerCase().trim()),
          );
        }
      });
      return master.filter((n) => !taken.has(String(n).toLowerCase().trim()));
    }

    // Separate rosters: each division runs on its own (original behavior, east then west).
    // Shared roster: one league-wide pass, worst points first across the league.
    const groups: string[][] = shared ? [league.slugs] : league.slugs.map((d) => [d]);

    const results: string[] = [];

    for (const groupDivs of groups) {
      // Waiver Disrupter is per division (blocks the others in the activator's division)
      const disrupters: Record<string, string> = {};
      for (const d of groupDivs) {
        const { data: sett } = await supabase
          .from("settings")
          .select("value")
          .eq("key", "waiver_disrupter_" + d)
          .maybeSingle();
        if (sett?.value) disrupters[d] = sett.value;
      }

      const order = Object.entries(users)
        .filter(([_, u]) => groupDivs.includes(u.division) && !u.purged)
        .map(([pin, u]) => ({
          pin,
          name: u.name,
          points: points[pin] || 0,
        }))
        .sort(
          (a, b) =>
            a.points - b.points || String(a.pin).localeCompare(String(b.pin)),
        );

      for (const team of order) {
        const claim = claimMap[team.pin];
        if (!claim?.ranked?.length) continue;
        const div = users[team.pin].division;
        const disrupterPin = disrupters[div] || null;

        if (disrupterPin && team.pin !== disrupterPin) {
          results.push(
            `🚫 ${team.name} — first claim blocked by Waiver Disrupter`,
          );
          await supabase.from("claims").delete().eq("pin", team.pin);
          continue;
        }

        const u = users[team.pin];
        const dropPool: string[] = [];
        if (Array.isArray(claim.drops) && claim.drops.length) {
          claim.drops.forEach((d: string) => {
            if (d) dropPool.push(d);
          });
        } else if (claim.drop) {
          dropPool.push(claim.drop);
        }
        let poolIdx = 0;
        let hits = 0;

        for (let ri = 0; ri < claim.ranked.length; ri++) {
          if (poolIdx >= dropPool.length) {
            results.push(
              `↪️ ${team.name} — drop pool empty (max ${dropPool.length})`,
            );
            break;
          }
          const wrestler = claim.ranked[ri];
          const avail = available(div);
          const match = avail.find(
            (w) =>
              String(w).toLowerCase().trim() ===
              String(wrestler).toLowerCase().trim(),
          );
          if (!match) {
            results.push(
              `↪️ ${team.name} #${ri + 1} ${wrestler} taken — try next`,
            );
            continue;
          }
          let drop: string | null = null;
          while (poolIdx < dropPool.length) {
            const cand = dropPool[poolIdx++];
            if (
              u.roster.some(
                (w: string) =>
                  String(w).toLowerCase() === String(cand).toLowerCase(),
              )
            ) {
              drop = cand;
              break;
            }
            results.push(`⚠️ ${team.name} drop ${cand} not on roster`);
          }
          if (!drop) {
            results.push(
              `⚠️ ${team.name} could take ${match} but no valid drop`,
            );
            break;
          }
          u.roster = u.roster.filter(
            (w: string) =>
              String(w).toLowerCase() !== String(drop).toLowerCase(),
          );
          u.roster.push(match);
          await supabase
            .from("teams")
            .update({ roster: u.roster })
            .eq("pin", team.pin);
          hits++;
          results.push(`✅ ${team.name} claimed ${match} (dropped ${drop})`);
        }

        await supabase.from("claims").delete().eq("pin", team.pin);
        await supabase
          .from("settings")
          .delete()
          .eq("key", "claim_drops_" + team.pin);

        if (!hits) results.push(`❌ ${team.name} — no claims filled`);
      }

      for (const d of Object.keys(disrupters)) {
        await supabase
          .from("settings")
          .delete()
          .eq("key", "waiver_disrupter_" + d);
      }
    }

    const reportText =
      results.length > 0 ? results.join("\n") : "No successful claims this run.";

    await supabase.from("waiver_reports").insert({
      division: "both",
      report: reportText,
    });

    await supabase.from("settings").upsert({
      key: "last_processed_deadline",
      value: deadlineRow.value,
    });

    const commish = (teams || []).find((t: any) => t.is_commissioner);
    if (commish) {
      await supabase.from("broadcasts").insert({
        from_pin: "system",
        target: commish.pin,
        message: "WAIVER WIRE AUTO-RUN COMPLETE\n\n" + reportText,
      });
    }

    return json({ ok: true, processed: true, results, report: reportText });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String(err) }, 500);
  }
});