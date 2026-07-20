/* ============================================================================
 * ATMons10 Campfire Pot Lure Planner
 * All data local & pack-accurate (mod jars + ATM10 KubeJS overlay, decompiled
 * mechanics). Spawn planner: least-competition biome + correct bait combo.
 * ==========================================================================*/
(function () {
  "use strict";

  const SEASONINGS = window.SEASONINGS, POKEMON = window.POKEMON, EGG = window.EGG_GROUPS,
        SPAWNS = window.SPAWNS, BIOME_TAGS = window.BIOME_TAGS, BIOME_NAMES = window.BIOME_NAMES;

  /* base spawn bucket odds (Cobblemon defaults) */
  const BUCKET_BASE = { "common": 94.3, "uncommon": 5.0, "rare": 0.5, "ultra-rare": 0.2 };
  const BUCKET_ORDER = ["common", "uncommon", "rare", "ultra-rare"];
  const SHINY_RATE = 8192;
  const CTX_NAME = { grounded: "Ground", surface: "Water surface", submerged: "Underwater",
                     seafloor: "Seafloor", fishing: "Fishing", lava: "Lava" };
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
          // Objective uses ONLY exact quantities (share and shiny odds). Rarity's
          // magnitude is modeled, so it must never drive slot allocation — it just
          // fills whatever slots the exact objective doesn't want.
          const score = share * (shiny ? shinyChance(rerolls) : 1);
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
  function planSpawn(pk, shiny) {
    if (!BIOME_INDEX) buildIndex();
    const idxs = []; SPAWNS.forEach((e, i) => { if (e.m === pk.key) idxs.push(i); });
    if (!idxs.length) return null;

    const evCodes = (pk.ev || []).slice();
    const matchers = matcherOptions(pk);
    const byName = new Map(), buckets = {};

    idxs.forEach(i => {
      const entry = SPAWNS[i];
      buckets[entry.b] = (buckets[entry.b] || 0) + 1;
      ENTRY_BIOMES[i].forEach(b => {
        const a = analyzeBiome(b, entry, evCodes, matchers, shiny);
        if (!a) return;
        a.biome = b; a.name = BIOME_NAMES[b] || b;
        const prev = byName.get(a.name);
        if (!prev || a.score > prev.score) byName.set(a.name, a);
      });
    });

    // rank by the exact objective, then by how few slots the share costs
    const options = [...byName.values()].sort((x, y) =>
      y.score - x.score || (x.nEv + x.nType) - (y.nEv + y.nType) || y.share - x.share);
    const primaryBucket = Object.keys(buckets).sort((a, b) => buckets[b] - buckets[a])[0] || "common";
    return { options, buckets: Object.keys(buckets), primaryBucket, matchers, evCodes };
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
   *  PRESENTATION — driven by Cobblemon's own Pokédex textures
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

  function doPlan() {
    const raw = $("#pokemon-input").value;
    const shiny = $("#shiny-toggle").checked;
    const entry = $("#entry"), combo = $("#combo"), list = $("#biome-list");
    entry.innerHTML = ""; combo.innerHTML = ""; list.innerHTML = "";

    if (!raw.trim()) { entry.appendChild(el("div", "hint", "Search a Pokémon to plan a hunt.")); return; }
    const pk = findPokemon(raw);
    if (!pk) { entry.appendChild(el("div", "warn", `“${raw}” is not in this Pokédex.`)); return; }

    const plan = planSpawn(pk, shiny);

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
    stat("EV yield", (pk.ev || []).map(c => EV_NAME[c]).join(", ") || "—");
    stat("Egg group", pk.eggGroups.map(eggDisplay).join(", ") || "—");
    if (plan) stat("Rarity", plan.buckets.map(bucketName).join(" / "));
    entry.appendChild(st);

    if (!plan) { combo.appendChild(el("p", "note", `No natural spawns in this pack — likely legendary, quest-locked or evolution-only.`)); return; }
    const top = plan.options[0];
    if (!top) { combo.appendChild(el("p", "note", "No biome data resolved.")); return; }

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
    if (!ids.length) combo.appendChild(el("p", "note", "Nothing in the pack helps — plain lure food."));

    const lv = el("div", "levers");
    [["No bait", top.baseShare], ["EV lock", top.evOnly], ["Type/egg", top.typeOnly], ["Combo", top.share]]
      .forEach(([lbl, val]) => {
        if (!val) return;
        const r = el("div", "lever" + (Math.abs(val - top.share) < 1e-9 ? " win" : ""));
        r.appendChild(el("span", null, lbl));
        const bar = el("span", "lever-bar"), f = el("span", "lever-fill");
        f.style.width = Math.max(3, Math.min(100, val * 100)) + "%"; bar.appendChild(f);
        r.appendChild(bar); r.appendChild(el("span", "lever-val", pct(val * 100)));
        lv.appendChild(r);
      });
    combo.appendChild(lv);

    const bits = [];
    if (shiny) bits.push("shiny ≈1 in " + Math.round(1 / shinyChance(top.rerolls)));
    if (top.rarity > 0) bits.push(`${bucketName(top.bucket)} bucket ${BUCKET_BASE[top.bucket]}% → ≈${pct(top.bucketOdds * 100)} (modeled)`);
    else if (top.bucket === "common") bits.push("no rarity bait — it would hurt a Common target");
    if (bits.length) combo.appendChild(el("p", "note", bits.join(" · ")));

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
      p.appendChild(el("b", null, pct(o.share * 100)));
      p.appendChild(el("small", null, "was " + pct(o.baseShare * 100)));
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

  /* ---------- fill the viewport: scale the 345x207 device to fit ---------- */
  const NATIVE_W = 345, NATIVE_H = 207;
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
    const availW = window.innerWidth - hPad;
    const availH = window.innerHeight - vPad - gap - creditsH;
    if (availW <= 0 || availH <= 0) return false;
    const s = Math.max(1.2, Math.min(availW / NATIVE_W, availH / NATIVE_H, 6.5));
    document.documentElement.style.setProperty("--s", s.toFixed(3));
    return true;
  }
  let fitTimer = null;
  function queueFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitDex, 80);
  }
  // Belt-and-suspenders: don't rely on any single event (resize/ResizeObserver
  // can be paused for backgrounded/not-yet-painted tabs) — retry on a short
  // backoff until a real layout is read, in addition to the live listeners.
  [0, 100, 300, 700, 1500].forEach(t => setTimeout(fitDex, t));

  function init() {
    const dl = $("#pokemon-datalist"), f = document.createDocumentFragment();
    Object.keys(POKEMON).forEach(k => { const o = document.createElement("option"); o.value = POKEMON[k].name; f.appendChild(o); });
    dl.appendChild(f);
    $("#pokemon-count").textContent = Object.keys(POKEMON).length.toLocaleString();
    $("#spawn-count").textContent = SPAWNS.length.toLocaleString();
    document.querySelectorAll(".seasoning-count").forEach(n => n.textContent = Object.keys(SEASONINGS).length);

    $("#reverse-form").addEventListener("submit", e => { e.preventDefault(); doPlan(); });
    $("#shiny-toggle").addEventListener("change", () => { if ($("#pokemon-input").value.trim()) doPlan(); });
    window.addEventListener("resize", queueFit);
    // ResizeObserver catches real layout changes (incl. the tab only
    // becoming visible/sized after init, which window.resize won't fire for).
    if (window.ResizeObserver) new ResizeObserver(queueFit).observe(document.documentElement);
    fitDex();
    doPlan();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
