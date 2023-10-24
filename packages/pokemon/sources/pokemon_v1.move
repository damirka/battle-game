// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/// This module implements the 1st generation algorithm for Pokemon, the example
/// and description of parameters can be found on the bulbapedia page:
/// https://bulbapedia.bulbagarden.net/wiki/Damage
///
/// Some parts of the algorithm including:
/// - The effectiveness of the move.
/// - The STAB (Same Type Attack Bonus) of the move.
/// ...are not included in the generic implementation because the Move
/// themselves should be defined by an application. To support better
/// calculation of extra modifiers, we return the damage as a scaled value.
///
/// Main functions of this algorithm:
/// - `physical_damage`: calculate the damage of a physical move.
/// - `special_damage`: calculate the damage of a special move.
///
/// All of the operations are performed on Stats. The `copy` allows for copying
/// and modifying the value if needed. The `store` allows for storing the Stats
/// as a dynamic field and the `drop` makes the cleanup easier.
module pokemon::pokemon_v1 {
    use pokemon::stats::{Self, Stats};

    /// The RANDOM parameter must be between 217 and 255 (inclusive).
    const EIncorrectRandomValue: u64 = 0;
    /// The MOVE_POWER parameter must be greater than 0.
    const EIncorrectMovePower: u64 = 1;

    /// Returns damage scaled by the given scaling factor. This is useful for
    /// keeping more decimal places in the result if the result is intended to
    /// be used in further calculations.
    public fun physical_damage(
        attacker: &Stats,
        defender: &Stats,
        move_power: u8,
        random: u8,
    ): u64 {
        assert!(random >= 217 && random <= 255, EIncorrectRandomValue);
        assert!(move_power > 0, EIncorrectMovePower);

        damage(
            (stats::level(attacker) as u64),
            (stats::attack(attacker) as u64),
            (stats::defense(defender) as u64),
            (move_power as u64),
            (random as u64),
            stats::scaling(),
        )
    }

    /// Calculate the special damage of a move.
    public fun special_damage(
        attacker: &Stats,
        defender: &Stats,
        move_power: u8,
        random: u8,
    ): u64 {
        assert!(random >= 217 && random <= 255, EIncorrectRandomValue);
        assert!(move_power > 0, EIncorrectMovePower);

        damage(
            (stats::level(attacker) as u64),
            (stats::special_attack(attacker) as u64),
            (stats::special_defense(defender) as u64),
            (move_power as u64),
            (random as u64),
            stats::scaling(),
        )
    }

    /// Calculate the damage of a move.
    /// This is the core calculation that is used by both physical and special
    /// damage calculations.
    ///
    /// - [x] TODO: missing the effectiveness calculation.
    /// - [x] TODO: missing the STAB calculation
    /// TODO: missing the critical hit calculation.
    /// TODO: missing the accuracy calculation.
    ///
    /// Resolution on todos:
    /// the types are application specific, and the move information too, so we
    /// can't really implement them here.
    fun damage(
        level: u64,
        attack: u64,
        defence: u64,
        move_power: u64,
        random: u64,
        scaling: u64,
    ): u64 {
        let lvl_mod = (2 * level * 1 / 5) + (2);
        let atk_def = (scaling * attack) / defence;
        let result  = (lvl_mod * move_power * atk_def / 50) + (2 * scaling);
        let rnd_val = (scaling * random) / 255;
        let eff_val = (1);

        (result * rnd_val * eff_val / scaling)
    }

    // === Tests ===

    #[test]
    fun test_physical() {
        let capy_one = stats::new(45, 49, 49, 65, 65, 45, 13, vector[]);
        let capy_two = stats::new(40, 60, 30, 31, 31, 70, 10, vector[]);

        let _damage = physical_damage(&capy_one, &capy_two, 40, 217);
        let _damage = physical_damage(&capy_two, &capy_one, 35, 230);
    }
}
