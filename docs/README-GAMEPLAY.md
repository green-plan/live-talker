# CS2 Game State Integration: Gameplay Logic & Telemetry Translation Guide

This specification guide details how to translate raw, continuous state feeds from Counter-Strike 2’s Game State Integration (GSI) into meaningful tactical context, semantic event flags, and narrative milestones. Use this mapping architecture to program analytical backends, broadcast overlays, or automated commentary prompts.

---

## 1. Macro Flow: Map & Round State Logic

CS2 operates on a strict phase-based state machine. Monitoring phase shifts provides the foundational context for filtering out noisy data.

### Map Phase Transitions (`map.phase`)
* `warmup` ➔ **Context:** Unranked practice window. Players are spawning infinitely with high cash. Disregard performance telemetry.
* `live` ➔ **Context:** The competitive match has started or resumed. Initialize state monitoring.
* `intermission` ➔ **Context:** Halftime or transition to Overtime. Players are swapping sides (CT to T, T to CT). Scores are preserved but player inventories and individual economies reset.
* `gameover` ➔ **Context:** Match finished. Final scores are locked.

### Round Phase Transitions (`round.phase`)
* `freezetime` ➔ **Context:** The 15-second shopping window. Players cannot move from spawn zones. Look for rapid drops in `player.state.money` to detect item purchases.
* `live` ➔ **Context:** The round is active. Freezetime barriers drop; combat, utility deployment, and map positioning begin.
* `over` ➔ **Context:** The win condition has been met. The engine locks player controls shortly after this transition. Compare team scores to verify who won the round.

---

## 2. Objective Dynamics: Bomb Telemetry Logic

The bomb (`round.bomb`) dictates the ultimate win/loss matrix for both teams. Tracking its state properties reveals shifts in tactical urgency.

### State Transitions & Deductions
* `carried` ➔ **Deduction:** The Terrorists hold the objective. The round proceeds under standard default rules (Ts must clear a site, CTs hold defensive angles).
* `dropped` ➔ **Deduction:** The bomb carrier died or manually tossed the objective. The map location of the bomb becomes the primary focal point. CTs will likely shift defensive positions to lock down the dropped item.
* `planted` ➔ **Deduction:** The round dynamics flip entirely. A hidden **40-second absolute countdown** begins. The structural win criteria change:
    * **CTs:** Must defuse the bomb. Eliminating all Terrorists is *no longer enough to win* if the clock runs out.
    * **Ts:** Must defend the site. Eliminating all CTs guarantees a win, but running away to preserve weaponry while letting the bomb explode is a viable option.
* `defused` ➔ **Deduction:** Immediate Counter-Terrorist victory. The round terminates instantly.
* `exploded` ➔ **Deduction:** Immediate Terrorist victory. The round terminates instantly.

---

## 3. Player Vitality & Combat Log Deductions

Because GSI transmits frames over HTTP rather than discrete actions, events must be calculated by identifying data differentials between the previous packet (Frame A) and the current packet (Frame B).

### The Lifecycle Delta
* **Logical Condition:** Frame A `player.state.health > 0` AND Frame B `player.state.health == 0`.
    * ➔ **Conclusion:** The player died.
    * ➔ **Downstream Tracking:** Look at `player.match_stats.deaths` to verify the kill count update. If `round.phase == "live"` and total alive players drops from 10 to 9, flag this frame as the **Entry Kill** of the round.
* **Logical Condition:** Frame A `player.state.health` > Frame B `player.state.health` (where Frame B > 0).
    * ➔ **Conclusion:** The player took non-lethal damage. Compare the difference against `player.state.armor` changes to determine if they absorbed damage via protective gear.

### Dynamic Combat Triggers
* **Vocal / State Blindness:** `player.state.flashed` maps to an integer scale (`0` to `255`).
    * ➔ **Conclusion:** Any value above `0` means the player is suffering from visual impairment via a flashbang. Values exceeding `200` indicate total flash blindness, meaning the player is completely defenseless.
* **Environmental Fire:** `player.state.burning > 0`.
    * ➔ **Conclusion:** The player is currently standing inside active Molotov or Incendiary fire. They are taking rapid health degradation and are forced to displace immediately.

---

## 4. Financial & Economy Tier Classifications

Evaluating financial states across entire teams during `freezetime` allows you to classify the strategic intent of a round. Do not evaluate players in isolation; average their assets per team.

### Equipment Value Analysis (`player.state.equip_value`)
The engine automatically calculates the exact dollar value of a player's current armor, weapons, and utility loadout:

* **Eco / Saving Tier (`equip_value < $1,500`)**
    * ➔ **Conclusion:** The team is protecting their cash reserve. They are fielding default pistols with minimal armor. Expect low win probability and fast-paced, high-risk aggregate pushes to damage enemy reserves.
* **Force Buy Tier (`$1,500 <= equip_value < $3,500`)**
    * ➔ **Conclusion:** The team lacks cash for a premium loadout but cannot afford to throw away another round. They are buying second-tier submachine guns (MAC-10, MP9), heavy pistols (Desert Eagle), and partial body armor.
* **Full Buy Tier (`equip_value >= $4,000`)**
    * ➔ **Conclusion:** Standard competitive baseline. The team is fully equipped with primary rifles (AK-47, M4A1-S, M4A4), full body armor + helmets, and a complete assortment of tactical grenades.

---

## 5. Advanced Compound Tactical Flags (Context Engine)

By aggregating multiple structural components simultaneously, your logic pipeline can deduce complex narrative scenarios:

### The Clutch Parameter (1vX State)
* **Logical Formula:** For Team Alpha, count players where `state.health > 0`. If count == `1` AND opposing Team Beta has `X` players alive (where X >= 1).
    * ➔ **Conclusion:** The remaining player is officially in a **Clutch Situation**.
    * ➔ **Narrative Urgency Scale:** If X==1 (1v1: Intense mental standoff); if X==3 (1v3: Low probability miracle scenario; player may choose to run away to save their weapon system).

### The Eco-Starved / Glass Cannon Trap
* **Logical Formula:** `player.state.money < $500` AND `player.weapons.weapon_awp` state is `"active"` AND `player.state.armor == 0`.
    * ➔ **Conclusion:** The player sacrificed protective body gear completely to afford a high-impact Sniper Rifle (AWP). They can eliminate targets instantly, but taking a single bullet from any distance will trigger severe aim-punch and near-instant death.

### The Ninja Defuse Setup
* **Logical Formula:** `round.bomb == "planted"` AND `player.team == "CT"` AND active weapon is `weapon_knife` OR weapon inventory shows no active firing state AND distance to bomb coordinates is collapsing toward zero while surviving Terrorists are still alive and in separate areas.
    * ➔ **Conclusion:** The Counter-Terrorist is attempting a stealth defuse without clearing the bomb site of enemy forces.

---

## 6. Implementation Template for Downstream Engines

When feeding GSI logs into an automation pipeline, filter the data into clean semantic states using this baseline JSON structural mapping format:

```json
{
  "telemetry_stream": {
    "round_status": "LIVE_COMBAT",
    "objective_state": "BOMB_PLANTED_TICKING",
    "time_bracket": "POST_PLANT_DEFENSE",
    "active_clutch": {
      "is_active": true,
      "clutcher_name": "Sable",
      "format": "1v2"
    },
    "combat_anomalies": {
      "target_blind": true,
      "target_burning": false
    },
    "financial_narrative": "CT_FORCE_VS_T_MAX_BUY"
  }
}