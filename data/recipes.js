/* ============================================================================
 * RECIPE DATA  (from the pack's real Cobblemon recipe files)
 * ----------------------------------------------------------------------------
 * data/cobblemon/recipe/campfire_pot/poke_snack.json  (shaped "cooking_pot")
 * data/cobblemon/recipe/campfire_pot/poke_bait.json   (shapeless)
 * Both accept any item tagged #cobblemon:recipe_filters/bait_seasoning in the
 * seasoning slot; the "spawn_bait" processor copies that item's bait effects
 * onto the food. Item ids resolve against data/items.js.
 * ==========================================================================*/
window.RECIPES = [
  {
    id: "cobblemon:poke_snack",
    name: "Poké Snack",
    subtitle: "Shaped · yields 1",
    layout: "shaped",
    seasoningSlots: 3,
    grid: [
      ["tag:c:drinks/milk",     "tag:c:drinks/milk",  "tag:c:drinks/milk"],
      ["minecraft:honey_bottle","cobblemon:vivichoke", "minecraft:honey_bottle"],
      ["cobblemon:hearty_grains","cobblemon:hearty_grains","cobblemon:hearty_grains"]
    ]
  },
  {
    id: "cobblemon:poke_bait",
    name: "Poké Bait",
    subtitle: "Shapeless · yields 4",
    layout: "shapeless",
    seasoningSlots: 3,
    ingredients: [
      "minecraft:honey_bottle",
      "tag:c:mushrooms",
      "minecraft:wheat"
    ]
  }
];
