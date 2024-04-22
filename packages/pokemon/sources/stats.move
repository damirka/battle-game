// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/// The stats module provides a set of functions for defining and working with
/// stats of the Pokemon. It's intentionally separated from the `pokemon_v1`
/// module to serve different algorithms in the future.
module pokemon::stats {
    /// The level can only be in [0; 100] range.
    const EIncorrectLevel: u64 = 0;

    /// Default scaling used in calculations. Needs to be tuned to not overflow
    /// Attempt to use 10^9 resulted in an overflow, so decreasing it by an order
    const SCALING_FACTOR: u64 = 1_000_000_00;

    /// The Stats of a Pokemon (basically, a structured collection of u8 values)
    /// Can be created using the `new` function.
    public struct Stats has copy, store, drop {
        /// The HP stat of the Pokemon: scaled by 10^9.
        hp: u64,
        /// The attack stat of the Pokemon.
        attack: u8,
        /// The defence stat of the Pokemon.
        defence: u8,
        /// The special attack stat of the Pokemon.
        special_attack: u8,
        /// The special defence stat of the Pokemon.
        special_defence: u8,
        /// The speed stat of the Pokemon.
        speed: u8,
        /// The level of the Pokemon (0-100)
        level: u8,
        /// The index of types of a Pokemon. Is required for STAB and effectiveness
        /// calculation, however, we don't include nor calculate it in this
        /// implementation - it needs to be added by the application.
        types: vector<u8>
    }

    // === Creation ===

    /// Create a new instance of Stats with the given values. It simplifies the
    /// calculation by wrapping the values in a struct.
    public fun new(
        hp: u8,
        attack: u8,
        defence: u8,
        special_attack: u8,
        special_defence: u8,
        speed: u8,
        level: u8,
        types: vector<u8>,
    ): Stats {
        assert!(level <= 100, EIncorrectLevel);

        Stats {
            hp: (hp as u64) * SCALING_FACTOR,
            attack,
            defence,
            special_attack,
            special_defence,
            speed,
            level,
            types,
        }
    }

    // === Getters ===

    /// Return the scaling factor used for damage calculation.
    public fun scaling(): u64 { SCALING_FACTOR }

    /// Return the HP stat of the given Pokemon.
    public fun hp(stat: &Stats): u64 { stat.hp }

    /// Return the attack stat of the given Pokemon.
    public fun attack(stat: &Stats): u8 { stat.attack }

    /// Return the defence stat of the given Pokemon.
    public fun defence(stat: &Stats): u8 { stat.defence }

    /// Return the special attack stat of the given Pokemon.
    public fun special_attack(stat: &Stats): u8 { stat.special_attack }

    /// Return the special defence stat of the given Pokemon.
    public fun special_defence(stat: &Stats): u8 { stat.special_defence }

    /// Return the speed stat of the given Pokemon.
    public fun speed(stat: &Stats): u8 { stat.speed }

    /// Return the level of the given Pokemon.
    public fun level(stat: &Stats): u8 { stat.level }

    /// Return the types of the given Pokemon.
    public fun types(stat: &Stats): vector<u8> { stat.types }

    // === Setters ===

    /// Set the HP stat of the given Pokemon.
    public fun decrease_hp(stat: &mut Stats, value: u64) {
        if (value > stat.hp) {
            stat.hp = 0;
        } else {
            stat.hp = stat.hp - value;
        }
    }

    /// Increase the level of the given Pokemon.
    public fun level_up(stat: &mut Stats) {
        stat.level = stat.level + 1;
    }
}
