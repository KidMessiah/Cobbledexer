/* ============================================================================
 * ATMons10 Campfire Pot Lure Planner
 * All data local & pack-accurate (mod jars + ATM10 KubeJS overlay, decompiled
 * mechanics). Spawn planner: least-competition biome + correct bait combo.
 * ==========================================================================*/
(function () {
  "use strict";

  const SEASONINGS = window.SEASONINGS, POKEMON = window.POKEMON, EGG = window.EGG_GROUPS,
        SPAWNS = window.SPAWNS, BIOME_TAGS = window.BIOME_TAGS, BIOME_NAMES = window.BIOME_NAMES,
        BIOME_MODS = window.BIOME_MODS || {}, LEGENDARIES = window.LEGENDARIES || {},
        ITEM_ICONS = window.ITEM_ICONS || {};

  /* base spawn bucket odds (Cobblemon defaults) */
  const BUCKET_BASE = { "common": 94.3, "uncommon": 5.0, "rare": 0.5, "ultra-rare": 0.2 };
  const BUCKET_ORDER = ["common", "uncommon", "rare", "ultra-rare"];
  const SHINY_RATE = 8192;
  const CTX_NAME = { grounded: "Ground", surface: "Water surface", submerged: "Underwater",
                     seafloor: "Seafloor", fishing: "Fishing", lava: "Lava" };
  // Fishing bait and pot-food bait are mechanically the same seasoned item: the
  // only difference is what you do with it (rod vs placed on the ground). See campfire-pot-planner memory.
  const DELIVERY = ctx => ctx === "fishing"
    ? { icon: "assets/ui/poke_rod.png", text: "Craft this seasoned Poké Bait, then attach it to your Poké Rod and fish here:" }
    : { icon: "assets/ui/poke_bait_icon.png", text: "Craft this into a Poké Snack or Poké Bait, then place it down and hunt here:" };
  const EV_NAME = { hp: "HP", atk: "Attack", def: "Defence", spa: "Sp. Atk", spd: "Sp. Def", spe: "Speed" };
  // ATM10 shiny seasonings we recommend
  const APPLE = "allthemodium:allthemodium_apple";   // shiny +10 AND rarity +12
  const CARROT = "allthemodium:allthemodium_carrot"; // shiny +10, no rarity

  /* ---------- helpers ---------------------------------------------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const titleCase = s => String(s).replace(/\b\w/g, c => c.toUpperCase());
  const round = (n, d = 2) => { const p = Math.pow(10, d); return Math.round(n * p) / p; };
  const pct = n => n >= 10 ? round(n, 1) + "%" : n >= 0.1 ? round(n, 2) + "%" : round(n, 3) + "%";

  const seasoningName = id => titleCase(id.split(":").pop().replace(/_/g, " "));
  const eggDisplay = id => (EGG.display && EGG.display[id]) || titleCase(id.replace(/_/g, " "));
  const bucketName = b => b === "ultra-rare" ? "Ultra-rare" : titleCase(b);
  // an evolution's `result` is sometimes "<species> <form>=<value>" (regional
  // forms, battle stances, etc, e.g. "aegislash stance_forme=shield") since
  // Cobblemon's evolution target can pin a specific form; POKEMON is keyed
  // by plain species id only, so strip the form suffix before any lookup.
  const baseSpeciesKey = id => String(id).split(" ")[0];
  // the stripped suffix itself, prettified for display (e.g. "alolan" -> " (Alolan)",
  // "stance_forme=shield" -> " (Shield)"); "" when there's no form suffix at all.
  function formSuffix(id) {
    const parts = String(id).split(" ");
    if (parts.length < 2) return "";
    const raw = parts.slice(1).join(" ");
    const val = raw.indexOf("=") >= 0 ? raw.slice(raw.indexOf("=") + 1) : raw;
    return val ? ` (${titleCase(val.replace(/_/g, " "))})` : "";
  }

  const POKE_INDEX = {};
  Object.keys(POKEMON).forEach(k => { POKE_INDEX[k.replace(/[^a-z0-9]/g, "")] = k; });
  function findPokemon(raw) {
    const l = String(raw).trim().toLowerCase(); if (!l) return null;
    if (POKEMON[l]) return Object.assign({ key: l }, POKEMON[l]);
    const loose = l.replace(/[^a-z0-9]/g, "");
    return POKE_INDEX[loose] ? Object.assign({ key: POKE_INDEX[loose] }, POKEMON[POKE_INDEX[loose]]) : null;
  }

  function resolveBiomes(refs) {
    const out = new Set();
    (refs || []).forEach(r => { const a = BIOME_TAGS[r]; if (a) a.forEach(b => out.add(b)); else out.add(r); });
    return out;
  }

  /* ---------- spawn probability model ----------------------------------- */
  // Rarity bait normalizes bucket weights: weight^(1/E), E=1.29+0.2*(tier-1).
  // tier scale vs bait value isn't exposed in the jar, so overall % is a MODEL.
  function normalizedBucketOdds(rarityValue) {
    if (!rarityValue || rarityValue <= 0) {
      const s = {}; BUCKET_ORDER.forEach(b => s[b] = BUCKET_BASE[b] / 100); return s;
    }
    const E = 1.29 + 0.2 * (rarityValue - 1);
    const w = {}; let sum = 0;
    BUCKET_ORDER.forEach(b => { w[b] = Math.pow(BUCKET_BASE[b], 1 / E); sum += w[b]; });
    const s = {}; BUCKET_ORDER.forEach(b => s[b] = w[b] / sum); return s;
  }
  function shinyChance(rerolls) { return 1 - Math.pow(1 - 1 / SHINY_RATE, 1 + (rerolls || 0)); }

  // The EV bait effect ZEROES the weight of anything not yielding that EV, so it
  // collapses the competition pool rather than boosting the target.
  function evBerryFor(code) {
    for (const id of Object.keys(SEASONINGS))
      for (const e of (SEASONINGS[id].baitEffects || []))
        if (e.type === "ev" && e.subcategory === code) return id;
    return null;
  }

  // every distinct type/egg category that has a seasoning attracting this Pokémon
  function matcherOptions(pk) {
    const best = new Map();
    for (const id of Object.keys(SEASONINGS)) {
      for (const e of (SEASONINGS[id].baitEffects || [])) {
        let cat = null;
        if (e.type === "typing" && pk.types.includes(e.subcategory))
          cat = { kind: "typing", sub: e.subcategory, label: titleCase(e.subcategory) + " type" };
        else if (e.type === "egg_group" && pk.eggGroups.includes(e.subcategory))
          cat = { kind: "egg_group", sub: e.subcategory, label: eggDisplay(e.subcategory) + " egg group" };
        if (!cat) continue;
        const k = cat.kind + ":" + cat.sub, prev = best.get(k);
        if (!prev || e.value > prev.value) best.set(k, Object.assign({ id: id, value: e.value }, cat));
      }
    }
    return [...best.values()];
  }

  /* ---------- disabled biome mods (persisted, not every mod that ships a ----
   * jar actually generates its biomes in every world) ---------------------- */
  const MODS_KEY = "luredex_disabled_mods";
  let DISABLED_MODS = new Set();
  try { DISABLED_MODS = new Set(JSON.parse(localStorage.getItem(MODS_KEY) || "[]")); } catch (_) {}
  function saveDisabledMods() {
    try { localStorage.setItem(MODS_KEY, JSON.stringify([...DISABLED_MODS])); } catch (_) {}
  }
  function biomeModEnabled(biomeId) { return !DISABLED_MODS.has(biomeId.split(":")[0]); }

  /* ---------- exact competition index (built from the raw spawn data) ----- */
  let BIOME_INDEX = null, ENTRY_BIOMES = null;
  function buildIndex() {
    BIOME_INDEX = Object.create(null);
    ENTRY_BIOMES = new Array(SPAWNS.length);
    SPAWNS.forEach((e, i) => {
      const b = resolveBiomes(e.bi);
      resolveBiomes(e.ab).forEach(x => b.delete(x));
      ENTRY_BIOMES[i] = b;
      b.forEach(x => { (BIOME_INDEX[x] || (BIOME_INDEX[x] = [])).push(i); });
    });
  }
  const speciesOf = e => POKEMON[e.m];
  function hasEv(e, code) { const s = speciesOf(e); return !!(s && s.ev && s.ev.indexOf(code) >= 0); }
  function hasCat(e, cat) {
    const s = speciesOf(e); if (!s) return false;
    return cat.kind === "typing" ? s.types.indexOf(cat.sub) >= 0 : s.eggGroups.indexOf(cat.sub) >= 0;
  }
  function effTotals(id) {
    let r = 0, s = 0;
    (SEASONINGS[id].baitEffects || []).forEach(e => {
      if (e.type === "rarity_bucket") r += e.value;
      if (e.type === "shiny_reroll") s += e.value;
    });
    return { r: r, s: s };
  }

  /* Exact share maths, straight from the decompiled mechanics:
   *   EV bait   -> every entry not yielding that EV has weight 0
   *   type/egg  -> weight *= V for EVERY entry in that category (rivals too)
   * so with pool weight T, category weight M, EV weight E, overlap EM:
   *   none      w/T          EV only   w/E
   *   type only (w·V)/(M·V + (T−M))    EV+type  (w·V)/(EM·V + (E−EM))          */
  function analyzeBiome(biome, entry, evCodes, matchers, shiny) {
    const pool = BIOME_INDEX[biome]; if (!pool) return null;
    const w = entry.w, bucket = entry.b;
    let T = 0; const E = {}, M = [], EM = {};
    evCodes.forEach(c => E[c] = 0);
    matchers.forEach((m, mi) => { M[mi] = 0; evCodes.forEach(c => EM[c + "|" + mi] = 0); });

    for (let k = 0; k < pool.length; k++) {
      const e = SPAWNS[pool[k]];
      if (e.c !== entry.c || e.b !== bucket) continue;
      T += e.w;
      const evHit = {};
      evCodes.forEach(c => { if (hasEv(e, c)) { evHit[c] = 1; E[c] += e.w; } });
      matchers.forEach((m, mi) => {
        if (!hasCat(e, m)) return;
        M[mi] += e.w;
        evCodes.forEach(c => { if (evHit[c]) EM[c + "|" + mi] += e.w; });
      });
    }
    if (T <= 0) return null;

    const isRare = bucket === "rare" || bucket === "ultra-rare";
    const fillerId = isRare ? APPLE : (shiny ? CARROT : null);
    const fill = fillerId ? effTotals(fillerId) : { r: 0, s: 0 };

    let best = null;
    const evList = evCodes.length ? evCodes : [];
    for (let nEv = 0; nEv <= (evCodes.length ? 1 : 0); nEv++) {
      for (let nType = 0; nType <= 3 - nEv; nType++) {
        const nFill = 3 - nEv - nType;
        if (nFill > 0 && !fillerId) continue;         // don't waste slots
        const cs = nEv ? evList : [null];
        const ms = nType ? matchers.map((_, i) => i) : [null];
        for (const c of cs) for (const mi of ms) {
          const V = (nType && mi != null) ? nType * matchers[mi].value : 0;
          let denom, numer;
          if (c != null && mi != null) { const em = EM[c + "|" + mi]; denom = em * V + (E[c] - em); numer = w * V; }
          else if (c != null) { denom = E[c]; numer = w; }
          else if (mi != null) { denom = M[mi] * V + (T - M[mi]); numer = w * V; }
          else { denom = T; numer = w; }
          if (!(denom > 0)) continue;
          const share = numer / denom;
          const rarity = nFill * fill.r, rerolls = nFill * fill.s;
          const bo = normalizedBucketOdds(rarity)[bucket];
          // Objective is the SAME real per-attempt quantity shown to the user
          // (bucketOdds x share x shinyChance), not share alone. An earlier
          // version deliberately excluded bucketOdds here ("rarity's magnitude
          // is modeled, so it must never drive slot allocation") to stop the
          // modeled rarity-bucket shift from dominating an exact comparison —
          // but that made the search blind to bucketOdds entirely, so for a
          // rare/ultra-rare target with an available type/EV lever, it would
          // always burn every slot on that lever even when trading a slot for
          // Apple's rarity boost is hugely better in reality. Confirmed on
          // Jirachi (ultra-rare, ev:hp, steel-type lever available): the old
          // share-only objective picked EV-lock + 2x type bait for a real
          // 0.17% chance, when EV-lock + 1x type + 1x Apple reaches 6.83% —
          // 40x better, because the modeled rarity shift for an ultra-rare
          // bucket target is large and CERTAIN in direction (only its exact
          // magnitude is modeled), so excluding it entirely was too
          // conservative. Safe to include unconditionally: for common/
          // uncommon targets the filler is Carrot (zero rarity_bucket effect,
          // see seasonings.js), so bucketOdds is a constant multiplier there
          // and never changes which split wins.
          const score = bo * share * (shiny ? shinyChance(rerolls) : 1);
          const used = nEv + nType;
          if (!best || score > best.score + 1e-12 ||
              (Math.abs(score - best.score) <= 1e-12 && used < best.nEv + best.nType))
            best = { score, share, nEv, nType, nFill, evCode: c, matcherIdx: mi, V,
                     rarity, rerolls, bucketOdds: bo, fillerId };
        }
      }
    }
    if (!best) return null;
    // reference numbers for the "which lever wins" comparison
    best.T = T; best.w = w; best.bucket = bucket; best.context = entry.c;
    best.baseShare = w / T;
    best.evOnly = evCodes.length ? Math.max.apply(null, evCodes.map(c => E[c] > 0 ? w / E[c] : 0)) : 0;
    best.typeOnly = matchers.length ? Math.max.apply(null, matchers.map((m, mi) => {
      const V = 3 * m.value; return (M[mi] * V + (T - M[mi])) > 0 ? (w * V) / (M[mi] * V + (T - M[mi])) : 0;
    })) : 0;

    // The REAL per-attempt encounter probability = P(this bucket gets rolled)
    // x P(this species wins the bucket). `share` alone (used above for slot
    // allocation, deliberately) omits the bucket-roll term entirely, which is
    // exact/known (94.3/5/0.5/0.2%) at baseline; omitting it is what made a
    // rare-bucket target with great "share" look better than a common-bucket
    // rival that's actually seen far more often in practice. This is the
    // number that should be shown to the player and used to rank options
    // against each other; `score`/`share` stay internal-only for slot search.
    const bo0 = BUCKET_BASE[bucket] / 100;
    best.chance = best.bucketOdds * best.share;
    best.baseChance = bo0 * best.baseShare;
    best.evOnlyChance = bo0 * best.evOnly;
    best.typeOnlyChance = bo0 * best.typeOnly;
    return best;
  }

  function comboRarity(ids) {
    let r = 0;
    ids.forEach(id => (SEASONINGS[id].baitEffects || []).forEach(e => { if (e.type === "rarity_bucket") r += e.value; }));
    return r;
  }
  function comboShiny(ids) {
    let s = 0;
    ids.forEach(id => (SEASONINGS[id].baitEffects || []).forEach(e => { if (e.type === "shiny_reroll") s += e.value; }));
    return s;
  }

  /* ---------- build the plan for a target ------------------------------- */
  // fishingOnly restricts to rod-delivered (context "fishing") spawns only.
  function planSpawn(pk, shiny, fishingOnly) {
    if (!BIOME_INDEX) buildIndex();
    const allIdxs = [], idxs = [];
    SPAWNS.forEach((e, i) => {
      if (e.m !== pk.key) return;
      allIdxs.push(i);
      if (!fishingOnly || e.c === "fishing") idxs.push(i);
    });
    if (!allIdxs.length) return null;
    const hasFishing = allIdxs.some(i => SPAWNS[i].c === "fishing");
    const hasNonFishing = allIdxs.some(i => SPAWNS[i].c !== "fishing");
    if (!idxs.length) return { options: [], buckets: [], primaryBucket: "common", matchers: [], evCodes: [], hasFishing, hasNonFishing };

    const evCodes = (pk.ev || []).slice();
    const matchers = matcherOptions(pk);
    // Keyed by biome+context (NOT biome alone): a biome can offer both a
    // walking spawn and a fishing spawn at once, and both should stay visible
    // instead of the higher-scoring one silently hiding the other.
    const byKey = new Map(), buckets = {};

    idxs.forEach(i => {
      const entry = SPAWNS[i];
      buckets[entry.b] = (buckets[entry.b] || 0) + 1;
      ENTRY_BIOMES[i].forEach(b => {
        if (!biomeModEnabled(b)) return;   // player untoggled this biome's source mod
        const a = analyzeBiome(b, entry, evCodes, matchers, shiny);
        if (!a) return;
        a.biome = b; a.name = BIOME_NAMES[b] || b;
        const key = a.name + "|" + a.context;
        const prev = byKey.get(key);
        if (!prev || a.chance > prev.chance) byKey.set(key, a);
      });
    });

    // rank by the REAL per-attempt probability (bucket odds x share), not the
    // within-bucket-only `score`: a great share in a rarely-rolled bucket
    // can still lose to a mediocre share in the common bucket.
    const options = [...byKey.values()].sort((x, y) =>
      y.chance - x.chance || (x.nEv + x.nType) - (y.nEv + y.nType) || y.share - x.share);
    const primaryBucket = Object.keys(buckets).sort((a, b) => buckets[b] - buckets[a])[0] || "common";
    return { options, buckets: Object.keys(buckets), primaryBucket, matchers, evCodes, hasFishing, hasNonFishing };
  }

  // Turn a winning strategy into the actual 3-slot seasoning list.
  function comboFromStrategy(s, matchers) {
    const out = [];
    if (s.nEv && s.evCode) { const id = evBerryFor(s.evCode); if (id) for (let i = 0; i < s.nEv; i++) out.push(id); }
    if (s.nType && s.matcherIdx != null) for (let i = 0; i < s.nType; i++) out.push(matchers[s.matcherIdx].id);
    if (s.nFill && s.fillerId) for (let i = 0; i < s.nFill; i++) out.push(s.fillerId);
    return out;
  }



  /* ======================================================================
   *  PRESENTATION: driven by Cobblemon's own Pokédex textures
   * ==================================================================== */
  const TYPE_COLORS = {
    normal: "#9fa19f", fire: "#e62829", water: "#2980ef", electric: "#d6a600",
    grass: "#3fa129", ice: "#3dcef3", fighting: "#d56723", poison: "#9141cb",
    ground: "#b07434", flying: "#7d9ee0", psychic: "#ef4179", bug: "#91a119",
    rock: "#8f844e", ghost: "#704170", dragon: "#5060e1", dark: "#5a4a46",
    steel: "#5f9aad", fairy: "#e070c0"
  };
  // Cobblemon ships platform_base_<type>.png for every type
  const PLATFORM_TYPES = Object.keys(TYPE_COLORS);
  const spriteKey = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

  function monImg(pk, shiny) {
    const img = document.createElement("img");
    img.className = "mon"; img.alt = pk.name;
    img.src = "assets/pokemon/" + spriteKey(pk.key) + (shiny ? "_shiny" : "") + ".png";
    img.onerror = function () {
      if (this.dataset.f) { this.onerror = null; this.src = "assets/ui/pokeball.png"; return; }
      this.dataset.f = 1; this.src = "assets/pokemon/" + spriteKey(pk.key) + ".png";
    };
    return img;
  }
  // a static, known-to-exist mod texture (rod, structure marker, ...)
  function uiIcon(src, cls) {
    const img = document.createElement("img");
    img.className = cls || "ni-icon"; img.alt = ""; img.src = src;
    return img;
  }
  // the evolution-direction sprites are 2-frame sheets (both frames identical,
  // same convention as .devtab-ic/.chk elsewhere): render as a background-image
  // span cropped to the top frame instead of an <img> that would show both.
  function arrowIcon(dir, cls) {
    const s = el("span", cls || "ni-icon arrow");
    s.style.backgroundImage = `url("assets/ui/arrow_${dir}.png")`;
    return s;
  }
  // a real item texture looked up by id, falling back to a pokeball for the
  // handful of items no installed jar ships a flat icon for (see itemicons.js)
  function itemIcon(id, cls) {
    const img = document.createElement("img");
    img.className = cls || "ni-icon"; img.alt = "";
    img.src = ITEM_ICONS[id] || "assets/ui/pokeball.png";
    img.onerror = function () { this.onerror = null; this.src = "assets/ui/pokeball.png"; };
    return img;
  }
  function platformFor(pk) {
    const t = (pk.types || [])[0];
    const name = PLATFORM_TYPES.indexOf(t) >= 0 ? "dex_platform_base_" + t + ".png" : "dex_platform_base.png";
    return "assets/ui/" + name;
  }
  // CobbleNav ships biome_platforms: bubbles/default/lava/plains/sand/stone/water
  function biomeDisc(name, ctx) {
    const n = name.toLowerCase();
    if (ctx === "submerged" || ctx === "seafloor") return "bubbles";
    if (/lava|nether|basalt|crimson|warped|magma/.test(n)) return "lava";
    if (ctx === "fishing" || ctx === "surface" || /ocean|sea|river|beach|coast|reef|shore|water|tidepool|lake/.test(n)) return "water";
    if (/desert|badlands|mesa|dune|sand|savanna|arid/.test(n)) return "sand";
    if (/cave|dripstone|deep|stone|mountain|peak|cliff|end|void|rock/.test(n)) return "stone";
    if (/forest|jungle|taiga|grove|wood|plain|meadow|floral|flower|field|grass|bamboo|cherry|swamp|lush/.test(n)) return "plains";
    return "default";
  }

  // Shininess persists through evolution, and bait boosts every spawn in its
  // radius, not just the target species. So if a family member (earlier OR
  // later stage) spawns far more often than the searched species, hunting
  // THAT one shiny and evolving it is a strictly better use of the same bait:
  // more spawns of it happen per unit of play, so more shiny rolls happen on
  // it, than would ever happen directly on the rarer target. Returns every
  // other species reachable via the evolution graph (ancestors AND
  // descendants, walking multi-step chains and branches), each tagged with
  // the ordered evolution step(s) needed to reach the searched species (for
  // an ancestor) or to reach that species FROM the searched one (descendant).
  function evolutionLine(pk) {
    const out = [];
    let cur = pk, chain = [];
    while (cur.preEvolution) {
      const preKey = baseSpeciesKey(cur.preEvolution);
      const pre = POKEMON[preKey]; if (!pre) break;
      const prePk = Object.assign({ key: preKey }, pre);
      const viaEntry = (pre.evolutions || []).find(e => baseSpeciesKey(e.result) === cur.key);
      chain = [viaEntry ? describeEvo(viaEntry) : { how: "evolving" }, ...chain];
      out.push({ pk: prePk, direction: "ancestor", steps: chain.slice() });
      cur = prePk;
    }
    (function walkDown(node, stepsSoFar) {
      (node.evolutions || []).forEach(e => {
        const nextKey = baseSpeciesKey(e.result);
        const next = POKEMON[nextKey]; if (!next) return;
        const nextPk = Object.assign({ key: nextKey }, next);
        const steps = stepsSoFar.concat([describeEvo(e)]);
        out.push({ pk: nextPk, direction: "descendant", steps });
        walkDown(nextPk, steps);
      });
    })(pk, []);
    return out;
  }

  function doPlan() {
    const raw = $("#pokemon-input").value;
    const shiny = $("#shiny-toggle").checked;
    const fishingOnly = $("#fishing-toggle").checked;
    const entry = $("#entry"), combo = $("#combo"), list = $("#biome-list");
    entry.innerHTML = ""; combo.innerHTML = ""; list.innerHTML = "";

    if (!raw.trim()) { entry.appendChild(el("div", "hint", "Search a Pokémon to plan a hunt.")); return; }
    const pk = findPokemon(raw);
    if (!pk) { entry.appendChild(el("div", "warn", `“${raw}” is not in this Pokédex.`)); return; }

    const plan = planSpawn(pk, shiny, fishingOnly);
    const topChance = (plan && plan.options[0]) ? plan.options[0].chance : 0;

    // Shininess persists through evolution, and bait boosts every spawn in
    // its radius, not just the target species, so hunting whichever family
    // member (earlier OR later stage) spawns most often gets more shiny
    // rolls for the same bait. Computed even when the target itself has NO
    // natural spawns at all (e.g. an item/quest-only evolution) so a
    // suggestion still shows up in that case, not just as a marginal upgrade.
    let bestAlt = null;
    if (shiny) {
      evolutionLine(pk).forEach(f => {
        const p2 = planSpawn(f.pk, shiny, fishingOnly);
        const t2 = p2 && p2.options[0];
        if (t2 && (!bestAlt || t2.chance > bestAlt.chance))
          bestAlt = { pk: f.pk, direction: f.direction, steps: f.steps, chance: t2.chance };
      });
    }
    // require a real, not-just-noise margin: at least 50% better AND at
    // least 0.05 percentage points, so two near-identical tiny odds don't
    // trigger a suggestion that isn't actually worth the detour.
    function altPathNote() {
      if (!bestAlt || !(bestAlt.chance > Math.max(topChance * 1.5, topChance + 0.0005))) return null;
      const altSteps = bestAlt.steps.map(s => s.how).join(", then ");
      const box = el("div", "altpath");
      box.appendChild(arrowIcon(bestAlt.direction === "ancestor" ? "left" : "right", "altpath-icon"));
      const t = el("div", "t2");
      t.appendChild(el("b", null, bestAlt.direction === "ancestor"
        ? `${bestAlt.pk.name} spawns much more often here: ${pct(bestAlt.chance * 100)} vs ${topChance ? pct(topChance * 100) : "0%"} for ${pk.name}.`
        : `${bestAlt.pk.name} (its evolution) spawns much more often here: ${pct(bestAlt.chance * 100)} vs ${topChance ? pct(topChance * 100) : "0%"}.`));
      t.appendChild(el("small", null, bestAlt.direction === "ancestor"
        ? `Catch it shiny instead, then evolve: ${altSteps}, to get ${pk.name}.`
        : `If a shiny ${bestAlt.pk.name} works too, evolve ${pk.name} via: ${altSteps}.`));
      box.appendChild(t);
      return box;
    }

    /* ---- portrait: sprite standing on its type platform ---- */
    const port = el("div", "portrait");
    const plate = el("div", "plate");
    plate.style.backgroundImage = `url("${platformFor(pk)}")`;
    port.appendChild(plate);
    port.appendChild(monImg(pk, shiny));
    entry.appendChild(port);

    const nb = el("div", "namebar");
    nb.appendChild(el("h2", null, pk.name));
    if (pk.dex) nb.appendChild(el("span", "no", "No." + String(pk.dex).padStart(4, "0")));
    entry.appendChild(nb);

    const ty = el("div", "types");
    pk.types.forEach(t => { const s = el("span", "type", t); s.style.background = TYPE_COLORS[t] || "#6e7c96"; ty.appendChild(s); });
    entry.appendChild(ty);

    const st = el("div", "stats");
    const stat = (lbl, val) => { const d = el("div", "stat"); d.appendChild(el("i", null, lbl)); d.appendChild(el("b", null, val)); st.appendChild(d); };
    stat("EV yield", (pk.ev || []).map(c => EV_NAME[c]).join(", ") || "None");
    stat("Egg group", pk.eggGroups.map(eggDisplay).join(", ") || "None");
    if (plan) stat("Rarity", plan.buckets.map(bucketName).join(" / "));
    entry.appendChild(st);

    if (!plan) {
      combo.appendChild(el("p", "note", `No natural spawns in this pack: likely legendary, quest-locked or evolution-only.`));
      const note0 = altPathNote(); if (note0) combo.appendChild(note0);
      return;
    }
    const top = plan.options[0];
    if (!top) {
      const msg = (fishingOnly && !plan.hasFishing && plan.hasNonFishing)
        ? `${pk.name} isn't caught by fishing in this pack, it only has other spawn types. Turn off "Fishing only" to see them.`
        : "No biome data resolved.";
      combo.appendChild(el("p", "note", msg));
      const note0 = altPathNote(); if (note0) combo.appendChild(note0);
      return;
    }
    if (plan.hasFishing && plan.hasNonFishing && !fishingOnly) {
      const hint = el("p", "note hint-toggle");
      hint.appendChild(uiIcon("assets/ui/poke_rod.png", "hint-icon"));
      hint.appendChild(el("span", null, `${pk.name} can also be fished. Toggle "Fishing only" for rod-specific results.`));
      combo.appendChild(hint);
    }

    /* ---- seasoning combo ---- */
    combo.appendChild(el("div", "lbl", "SEASONING SLOTS"));
    const ids = comboFromStrategy(top, plan.matchers);
    const counts = {}; ids.forEach(i => counts[i] = (counts[i] || 0) + 1);
    Object.keys(counts).forEach(id => {
      const b = el("div", "bait");
      const dot = el("span", "dot"); dot.style.background = colourHex(SEASONINGS[id].colour); b.appendChild(dot);
      const n = el("div", "n");
      n.appendChild(el("b", null, (counts[id] > 1 ? counts[id] + "× " : "") + seasoningName(id)));
      n.appendChild(el("small", null, roleOf(id, top, plan)));
      b.appendChild(n);
      combo.appendChild(b);
    });
    if (!ids.length) combo.appendChild(el("p", "note", "Nothing in the pack helps here, plain lure food works fine."));
    else {
      const d = DELIVERY(top.context);
      const row = el("p", "note delivery");
      row.appendChild(uiIcon(d.icon, "delivery-icon"));
      row.appendChild(el("span", null, d.text));
      combo.appendChild(row);
    }

    const lv = el("div", "levers");
    [["No bait", top.baseChance], ["EV lock", top.evOnlyChance], ["Type/egg", top.typeOnlyChance], ["Combo", top.chance]]
      .forEach(([lbl, val]) => {
        if (!val) return;
        const r = el("div", "lever" + (Math.abs(val - top.chance) < 1e-12 ? " win" : ""));
        r.appendChild(el("span", null, lbl));
        const bar = el("span", "lever-bar"), f = el("span", "lever-fill");
        f.style.width = Math.max(3, Math.min(100, val * 100)) + "%"; bar.appendChild(f);
        r.appendChild(bar); r.appendChild(el("span", "lever-val", pct(val * 100)));
        lv.appendChild(r);
      });
    combo.appendChild(lv);
    combo.appendChild(el("p", "note", "% = actual chance per spawn attempt (bucket roll × species odds within it), comparable to your in-game PokeFinder readout, but with your bait applied."));

    const bits = [];
    if (shiny) bits.push("shiny ≈1 in " + Math.round(1 / shinyChance(top.rerolls)));
    if (top.rarity > 0) bits.push(`${bucketName(top.bucket)} bucket ${BUCKET_BASE[top.bucket]}% -> ≈${pct(top.bucketOdds * 100)} (modeled)`);
    else if (top.bucket === "common") bits.push("no rarity bait: it would hurt a Common target");
    if (bits.length) combo.appendChild(el("p", "note", bits.join(" · ")));

    const altNote = altPathNote(); if (altNote) combo.appendChild(altNote);

    /* ---- biome rows ---- */
    plan.options.slice(0, 20).forEach((o, i) => {
      const r = el("div", "row" + (i === 0 ? " best" : ""));
      const d = el("img", "plat");
      d.src = "assets/ui/nav_biome_platforms_" + biomeDisc(o.name, o.context) + ".png";
      d.alt = ""; r.appendChild(d);
      const t = el("div", "t");
      t.appendChild(el("b", null, o.name));
      t.appendChild(el("small", null, (CTX_NAME[o.context] || o.context) + " · " +
        (o.nEv && o.nType ? "EV + type" : o.nEv ? "EV lock" : o.nType ? "type/egg" : "no bait needed")));
      r.appendChild(t);
      const p = el("div", "pc");
      p.appendChild(el("b", null, pct(o.chance * 100)));
      p.appendChild(el("small", null, "was " + pct(o.baseChance * 100)));
      r.appendChild(p);
      list.appendChild(r);
    });
  }

  function roleOf(id, top, plan) {
    const fx = SEASONINGS[id].baitEffects || [];
    if (fx.some(e => e.type === "ev")) return "locks pool to " + EV_NAME[top.evCode] + " EV";
    if (top.matcherIdx != null && id === plan.matchers[top.matcherIdx].id)
      return "×" + top.V + " " + plan.matchers[top.matcherIdx].label;
    const t = effTotals(id);
    return [t.s ? "+" + t.s + " shiny" : "", t.r ? "+" + t.r + " rarity" : ""].filter(Boolean).join(" · ") || "filler";
  }

  function colourHex(n) {
    const m = { pink: "#ff8fc7", orange: "#ff9d3d", yellow: "#f5cf47", blue: "#4f9dff", cyan: "#43c9d0",
      red: "#ff5d5d", purple: "#b06dff", green: "#5ec96b", white: "#eaeaea", black: "#4b515c",
      brown: "#a9763f", gray: "#9aa0a6", grey: "#9aa0a6", lime: "#9ccc3c", magenta: "#e05fd0",
      light_blue: "#7fc7ff", light_gray: "#c2c7cd" };
    return m[(n || "").toLowerCase()] || "#8a8f98";
  }

  /* ======================================================================
   *  POKÉ FINDER ("where & how to get it"): wild spawns, evolution, fossils,
   *  legendary/mythical/Ultra Beast quest requirements (structure + item).
   * ==================================================================== */
  const itemLabel = id => titleCase(id.split(":").pop().replace(/_/g, " "));

  function describeRequirement(r) {
    switch (r.variant) {
      case "level": return `reach level ${r.minLevel}`;
      case "friendship": return `friendship ${r.amount}+ (feed/battle/walk with it, keep it healthy)`;
      case "time_range": return `during ${r.range === "day" ? "the day" : r.range === "night" ? "the night" : r.range}`;
      case "has_move_type": return `while it knows a ${titleCase(r.type)}-type move`;
      case "move": return `while it knows ${titleCase((r.move || "").replace(/_/g, " "))}`;
      default: return "a special condition";
    }
  }
  function describeEvo(e) {
    const into = e.result ? POKEMON[baseSpeciesKey(e.result)] : null;
    const name = into ? into.name + formSuffix(e.result) : titleCase(baseSpeciesKey(e.result || "?"));
    const reqs = (e.requirements || []).map(describeRequirement);
    let how;
    if (e.variant === "item_interact" && e.item) how = `use a ${itemLabel(e.item)} on it`;
    else if (e.variant === "trade") how = "trade it to another player (or NPC trade)";
    else if (e.variant === "level_up") how = reqs.length ? reqs.join(", ") : "level it up";
    else how = reqs.join(", ") || (e.variant || "").replace(/_/g, " ") || "a special method";
    if (e.variant === "level_up" && reqs.length && !how.startsWith("reach")) how = "level up, " + how;
    return { name, how };
  }

  function navSection(title) {
    const s = el("div", "nav-sec");
    s.appendChild(el("h4", null, title));
    return s;
  }

  function doNavSearch() {
    const raw = $("#nav-input").value;
    const results = $("#nav-results");
    results.innerHTML = "";
    if (!raw.trim()) { results.appendChild(el("p", "nav-empty", "Search a Pokémon to see where & how to get it.")); return; }
    const pk = findPokemon(raw);
    if (!pk) { results.appendChild(el("p", "nav-warn", `“${raw}” is not in this Pokédex.`)); return; }

    const hero = el("div", "nav-hero");
    const sw = el("div", "sprite-wrap"); sw.appendChild(monImg(pk, false)); hero.appendChild(sw);
    const info = el("div");
    const nameRow = el("div");
    nameRow.appendChild(el("span", "nh-name", pk.name));
    if (pk.dex) nameRow.appendChild(el("span", "nh-no", "#" + String(pk.dex).padStart(4, "0")));
    info.appendChild(nameRow);
    const ty = el("div", "nh-types");
    pk.types.forEach(t => { const s = el("span", "nh-type", t); s.style.background = TYPE_COLORS[t] || "#6e7c96"; ty.appendChild(s); });
    info.appendChild(ty);
    hero.appendChild(info);
    results.appendChild(hero);

    let anySection = false;

    // ---- legendary / mythical / ultra beast / paradox (check first, most specific) ----
    const leg = LEGENDARIES[pk.key];
    if (leg) {
      anySection = true;
      const sec = navSection(leg.category === "ultra-beast" ? "Ultra Beast"
        : leg.category === "paradox" ? "Paradox Pokémon" : "Legendary / Mythical");
      // Universal gate, verified directly in the pack's own
      // kubejs/startup_scripts/catch_restrictions.js: a Poké Ball can NEVER
      // be thrown at any Legendary/Mythical/Ultra Beast/Paradox species
      // outside of battle, and a battle against a wild one (or using an
      // already-owned one in ANY battle) is blocked entirely until the
      // player has completed a Summoning Ritual for that species' home
      // region. Applies on top of whatever gets you INTO a battle with it in
      // the first place. Absent only for Melmetal/Meltan (no mapped region).
      const pikaNote = leg.region && el("p", "nav-note",
        `Also needs the ${leg.region} Pika Star: a Summoning Ritual (defeat the ATM Team trainer series once, then ritual 4 ancient Poké Balls, 4 Mega Stones and several of your own ${leg.region}-native Pokémon at a Summoning Ritual Altar). Without it you can't even battle a wild one, let alone catch it. Poké Balls only work once it's already in a battle.`);
      if (leg.category === "ultra-beast") {
        // NOT a plain bait-optimizable wild spawn like the rest of this app
        // models — confirmed from the chapter's own quest text ("Ultra
        // Wormholes"): a timed random event, not a biome you can camp.
        sec.appendChild(el("p", "nav-note",
          "Ultra Beasts don't wander the world normally. Roughly once an hour an Ultra Wormhole tears open in The Other and one steps through as a buffed, high-level boss; fight it down before the rift closes, then a ball works. A Beast Ball gives the best odds."));
        if (pikaNote) sec.appendChild(pikaNote);
      } else if (leg.category === "paradox") {
        // CORRECTION (2026-07-22): earlier said these are plain wild spawns,
        // no ritual needed. That was wrong. Checked kubejs/server_scripts/
        // Tweaks/disable_mons.js directly: the paradox_spawns_ccc file was
        // this species' ONLY spawn source anywhere in the pack, and that
        // exact file is explicitly zeroed out at game launch. No replacement
        // ritual exists for Paradox mons in the current data (unlike
        // Magearna, which got a dedicated new one), so say so plainly
        // instead of pointing at a biome list that no longer exists.
        sec.appendChild(el("p", "nav-note",
          `No functional wild spawn found for ${pk.name} in this pack right now. Its spawn source is explicitly disabled in the pack's own scripts, and no replacement ritual is documented anywhere. Check the quest book in-game or community resources to confirm how this pack currently intends it to be obtained.`));
        if (pikaNote) sec.appendChild(pikaNote);
      } else {
        if (pikaNote) sec.appendChild(pikaNote);
        if (leg.structure) {
          const it = el("div", "nav-item");
          it.appendChild(uiIcon("assets/ui/nav_radialmenu_location.png"));
          it.appendChild(el("b", null, leg.structure.name));
          it.appendChild(el("span", "ni-sub", "structure to find"));
          sec.appendChild(it);
        }
        if (leg.dimension) sec.appendChild(el("p", "nav-note", `Located in: ${leg.dimension}`));
        (leg.items || []).forEach(item => {
          const it = el("div", "nav-item");
          it.appendChild(itemIcon(item.id));
          it.appendChild(el("b", null, item.name));
          it.appendChild(el("span", "ni-sub", "required item"));
          sec.appendChild(it);
          if (item.tooltip) sec.appendChild(el("p", "nav-note", item.tooltip));
          if (item.recipe && item.recipe.length) {
            const chain = el("div", "nav-chain");
            chain.appendChild(el("span", null, "Made from:"));
            item.recipe.forEach((ing, i) => {
              if (i > 0) chain.appendChild(el("span", "arrow", "+"));
              const chip = el("span", "chip", ing.name);
              chip.title = ing.tooltip || "";
              chain.appendChild(chip);
            });
            sec.appendChild(chain);
            const withTip = item.recipe.filter(r => r.tooltip);
            if (withTip.length) sec.appendChild(el("p", "nav-note",
              withTip.map(r => `${r.name}: ${r.tooltip}`).join(" · ")));
          }
        });
        if (leg.note) sec.appendChild(el("p", "nav-note", leg.note));
        if (!leg.structure && !(leg.items || []).length) {
          // 8 species (Cosmoem/Lunala/Solgaleo/Naganadel/Phione/Silvally/
          // Urshifu/Zygarde) are restricted per their own species label but
          // have no FTB Quests entry at all, most are evolution-only, not
          // independently caught, so point at the Evolution section instead
          // of implying a missing/undocumented ritual.
          sec.appendChild(el("p", "nav-note", pk.preEvolution
            ? `No separate catch method found for ${pk.name} itself, it looks like it's obtained by evolving its pre-evolution instead (see Evolution below).`
            : "No structure/item requirement found. Check the quest book's Legendaries chapter in-game for this one."));
        }
      }
      results.appendChild(sec);
    }

    // ---- evolution ----
    if (pk.preEvolution || (pk.evolutions && pk.evolutions.length)) {
      anySection = true;
      const sec = navSection("Evolution");
      if (pk.preEvolution) {
        const pre = POKEMON[pk.preEvolution];
        const preName = pre ? pre.name : titleCase(pk.preEvolution);
        // find the specific evolution entry on the pre-evolution that leads here
        const viaEntry = pre && pre.evolutions ? pre.evolutions.find(e => baseSpeciesKey(e.result) === pk.key) : null;
        const how = viaEntry ? describeEvo(viaEntry).how : "evolving";
        const row = el("div", "nav-item");
        row.appendChild(arrowIcon("left"));
        row.appendChild(el("b", null, preName));
        row.appendChild(el("span", "ni-sub", how));
        sec.appendChild(row);
      }
      (pk.evolutions || []).forEach(e => {
        const d = describeEvo(e);
        const row = el("div", "nav-item");
        row.appendChild(arrowIcon("right"));
        row.appendChild(el("b", null, d.name));
        row.appendChild(el("span", "ni-sub", d.how));
        sec.appendChild(row);
      });
      results.appendChild(sec);
    }

    // ---- fossil revival ----
    if (pk.fossils && pk.fossils.length) {
      anySection = true;
      const sec = navSection("Fossil revival");
      const row = el("div", "nav-item");
      row.appendChild(itemIcon(pk.fossils[0]));
      row.appendChild(el("b", null, pk.fossils.map(itemLabel).join(" + ")));
      row.appendChild(el("span", "ni-sub", "at a Fossil Machine"));
      sec.appendChild(row);
      results.appendChild(sec);
    }

    // ---- where it's found: real biome list, baseline (no-bait) odds only.
    // Deliberately NOT the seasoning-combo/lure optimizer: that's Lure Dex's
    // job. Skipped for Ultra Beasts, their note above already covers it.
    const hasSpawn = SPAWNS.some(e => e.m === pk.key);
    if (hasSpawn && !(leg && leg.category === "ultra-beast")) {
      anySection = true;
      const plan = planSpawn(pk, false, false);
      const sec = navSection("Where it's found");
      if (plan && plan.options.length) {
        const byBaseline = [...plan.options].sort((a, b) => b.baseChance - a.baseChance);
        const list = el("div", "nav-biomes");
        byBaseline.slice(0, 6).forEach((o, i) => {
          const row = el("div", "nav-biome" + (i === 0 ? " best" : ""));
          const t = el("div", "nbn");
          t.appendChild(el("b", null, o.name));
          t.appendChild(el("small", null, (CTX_NAME[o.context] || o.context) + " · " + bucketName(o.bucket)));
          row.appendChild(t);
          row.appendChild(el("div", "nbp", pct(o.baseChance * 100)));
          list.appendChild(row);
        });
        sec.appendChild(list);
        if (leg && leg.structure) sec.appendChild(el("p", "nav-note",
          `This is a natural wild-spawn chance independent of the ritual above, a rare bonus path rather than a reliable one.`));
        sec.appendChild(el("p", "nav-note",
          "Baseline odds shown, no seasoning applied. Switch to the Lure Dex tab for the best bait combo and boosted odds."));
      } else {
        sec.appendChild(el("p", "nav-note", `${pk.name} spawns naturally in this pack, but no biome could be resolved.`));
      }
      results.appendChild(sec);
    }

    if (!anySection) {
      results.appendChild(el("p", "nav-empty",
        `No spawn, evolution, fossil or quest data found for ${pk.name} in this pack. It may be a form/variant, egg-only, or otherwise event-locked.`));
    }
  }

  /* ---------- fill the viewport: scale the active device to fit ---------- */
  // Two devices share one --s scale var, but have different native canvases
  // (Cobblemon's Pokédex is 345x207; CobbleNav's PokeNav is 350x250), fit
  // against whichever is currently visible.
  const DEVICE_DIMS = { dex: [345, 207], nav: [350, 250] };
  let activeTab = "dex";
  function fitDex() {
    // window dimensions can legitimately read 0 for a beat (tab not yet
    // painted); skip rather than bake a bogus tiny scale in permanently.
    if (!window.innerWidth || !window.innerHeight) return false;
    const credits = $(".credits");
    const bodyStyle = getComputedStyle(document.body);
    const hPad = parseFloat(bodyStyle.paddingLeft) + parseFloat(bodyStyle.paddingRight);
    const vPad = parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom);
    const gap = parseFloat(bodyStyle.rowGap) || 10;
    const creditsH = credits ? credits.offsetHeight : 0;
    // the tab flap (.devtabs) sits absolutely above the device (up to -9
    // native px * scale) and doesn't occupy flex flow, so it can't be
    // measured via offsetHeight, so reserve a flat allowance for it instead.
    const TAB_HEADROOM = 60;
    const availW = window.innerWidth - hPad;
    const availH = window.innerHeight - vPad - gap - creditsH - TAB_HEADROOM;
    if (availW <= 0 || availH <= 0) return false;
    const scaleFor = ([w, h]) => Math.max(1.2, Math.min(availW / w, availH / h, 6.5));
    const s = scaleFor(DEVICE_DIMS[activeTab]);
    document.documentElement.style.setProperty("--s", s.toFixed(3));
    // --ts (text scale) is pinned to the Lure Dex tab's OWN fit, regardless of
    // which device is active: Poké Finder's native canvas is taller (250 vs
    // 207), so its own best-fit --s comes out ~15-20% smaller at most window
    // sizes, which made its text/rows look shrunk and out of step with the
    // Lure Dex tab. --s still controls each device's frame/bezel (must match
    // that device's own real texture pixel grid); --ts is what everything
    // INSIDE the Poké Finder screen (free-form CSS, not texture-aligned) uses
    // instead, so its text always matches the Lure Dex tab's size.
    document.documentElement.style.setProperty("--ts", scaleFor(DEVICE_DIMS.dex).toFixed(3));
    return true;
  }
  function switchTab(tab) {
    if (tab === activeTab) return;
    activeTab = tab;
    document.querySelectorAll(".devtab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    $("#device-dex").classList.toggle("hidden", tab !== "dex");
    $("#device-nav").classList.toggle("hidden", tab !== "nav");
    fitDex();
  }
  let fitTimer = null;
  function queueFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitDex, 80);
  }
  // Belt-and-suspenders: don't rely on any single event (resize/ResizeObserver
  // can be paused for backgrounded/not-yet-painted tabs), so retry on a short
  // backoff until a real layout is read, in addition to the live listeners.
  [0, 100, 300, 700, 1500].forEach(t => setTimeout(fitDex, t));

  /* ---------- settings panel (biome mod toggles) ------------------------- */
  function renderSettingsList() {
    const list = $("#settings-list");
    list.innerHTML = "";
    Object.keys(BIOME_MODS).forEach(ns => {
      const mod = BIOME_MODS[ns];
      const on = !DISABLED_MODS.has(ns);
      const row = el("div", "mod-row " + (on ? "on" : "off"));
      row.appendChild(el("span", "chk"));
      row.appendChild(el("span", "mn", mod.label));
      row.appendChild(el("span", "mc", mod.biomes + " biomes"));
      row.addEventListener("click", () => {
        if (DISABLED_MODS.has(ns)) DISABLED_MODS.delete(ns); else DISABLED_MODS.add(ns);
        saveDisabledMods();
        row.classList.toggle("on");
        row.classList.toggle("off");
        if ($("#pokemon-input").value.trim()) doPlan();
      });
      list.appendChild(row);
    });
  }
  function openSettings() { $("#settings-overlay").classList.remove("hidden"); }
  function closeSettings() { $("#settings-overlay").classList.add("hidden"); }

  function init() {
    const dl = $("#pokemon-datalist"), f = document.createDocumentFragment();
    Object.keys(POKEMON).forEach(k => { const o = document.createElement("option"); o.value = POKEMON[k].name; f.appendChild(o); });
    dl.appendChild(f);
    $("#pokemon-count").textContent = Object.keys(POKEMON).length.toLocaleString();
    $("#spawn-count").textContent = SPAWNS.length.toLocaleString();
    document.querySelectorAll(".seasoning-count").forEach(n => n.textContent = Object.keys(SEASONINGS).length);
    renderSettingsList();

    $("#reverse-form").addEventListener("submit", e => { e.preventDefault(); doPlan(); });
    $("#shiny-toggle").addEventListener("change", () => { if ($("#pokemon-input").value.trim()) doPlan(); });
    $("#fishing-toggle").addEventListener("change", () => { if ($("#pokemon-input").value.trim()) doPlan(); });
    $("#settings-btn").addEventListener("click", openSettings);
    $("#settings-close").addEventListener("click", closeSettings);
    $("#settings-overlay").addEventListener("click", e => { if (e.target.id === "settings-overlay") closeSettings(); });
    $("#preset-atmons10").addEventListener("click", () => {
      DISABLED_MODS = new Set(Object.keys(BIOME_MODS).filter(ns => !BIOME_MODS[ns].installed));
      saveDisabledMods();
      renderSettingsList();
      if ($("#pokemon-input").value.trim()) doPlan();
    });
    document.querySelectorAll(".devtab").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    $("#nav-form").addEventListener("submit", e => { e.preventDefault(); doNavSearch(); });
    window.addEventListener("resize", queueFit);
    // ResizeObserver catches real layout changes (incl. the tab only
    // becoming visible/sized after init, which window.resize won't fire for).
    if (window.ResizeObserver) new ResizeObserver(queueFit).observe(document.documentElement);
    fitDex();
    doPlan();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
