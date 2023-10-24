// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/// So what we have so far:
/// - a lame calculation of Stats for a Capy - using the raw bytes is a bit crazy
/// as we don't cap them and some Capys may have 255 ATK from the start of DEF 0.
/// Balancing out the values is something that we'll eventually pick up.
/// - an extension which allows us to perform a registration of stats -> and then
/// copy these stats into a temporary storage for the battle. However, there's no
/// way to apply the results to the Capy yet.
///
/// What's the goal of this module? And what's our next step? We want to finish the
/// pokemon battle algorithm and register some Moves and type Effectiveness. We've
/// been testing the prototype written in JS for a couple days, so it's safe to port
/// and reuse the knowledge we've gained.
///
/// What to expect? Better stats distribution of course!
module prototype::battle {
    use std::vector;
    use pokemon::pokemon_v1 as pokemon;
    use pokemon::stats::{Self, Stats};

    /// Trying to use a non-existent Move (only use 0, 1, 2).
    const EWrongMove: u64 = 0;

    /// Same type attack bonus. Requires division by `EFF_SCALING` when used.
    const STAB_BONUS: u64 = 15;

    /// Starting with 3 Moves (and corresponding types). Each Capy can choose
    /// to attack with one of these Moves.
    const MOVES_POWER: vector<u8> = vector[
        40, // Rock
        60, // Paper
        80, // Scissors
    ];

    /// The map of effectiveness of Moves against types. The first index is the
    /// type of the Move, the second index is the type of the Capy this Move is
    /// used against.
    const MOVES_EFFECTIVENESS: vector<vector<u64>> = vector[
        // Rock: equally effective against all types + 2x against Scissors
        vector[10, 10, 20],
        // Paper: aren't effective against Scissors but are moderate against Rock and Scissors
        vector[10, 10, 5],
        // Scissors: aren't effective against Rock but are effective against Paper
        vector[5, 20, 10],
    ];

    /// This is the scaling for effectiveness and type bonus. Both are in range
    /// 0-2, so we need to scale them to 0-20 to apply in the uint calculations.
    const EFF_SCALING: u64 = 10;

    // TODO: remove once debug is over
    use std::string::utf8;

    /// It magically wraps the HP decreasing.
    public fun attack(attacker: &Stats, defender: &mut Stats, _move: u64, rng: u8, debug: bool) {
        assert!(_move < 3, EWrongMove);

        // Currently Capys only have 1 type. Pokemons can have up to 2 types.
        let attacker_type = (*vector::borrow(&stats::types(attacker), 0) as u64);
        let defender_type = (*vector::borrow(&stats::types(defender), 0) as u64);

        let move_power = *vector::borrow(&MOVES_POWER, _move);
        let raw_damage = pokemon::physical_damage(
            attacker,
            defender,
            move_power,
            rng
        );

        // Get the effectiveness table for this specifc Move, then look up defender's
        // type in the table by index. That would be the TYPE1 modifier.
        let move_effectiveness = *vector::borrow(&MOVES_EFFECTIVENESS, _move);
        let effectiveness = *vector::borrow(&move_effectiveness, defender_type);

        // TODO: remove in the future.
        if (debug) {
            std::debug::print(&utf8(b"Defender type, effectiveness, original damage, new damage"));
            std::debug::print(&vector[
                defender_type,
                effectiveness,
                raw_damage / 1_000_000_000,
                (raw_damage * effectiveness / EFF_SCALING / 1_000_000_000)
            ]);
        };

        // Effectiveness of a move against the type is calculated as:
        raw_damage = raw_damage * effectiveness / EFF_SCALING;

        if (debug) {
            std::debug::print(&utf8(b"Attacker type and move"));
            std::debug::print(&vector[attacker_type, _move]);
        };

        // Same type attack bonus = STAB - adds 50% to the damage.
        if (_move == attacker_type) {
            if (debug) std::debug::print(&utf8(b"Same type attack bonus!"));
            raw_damage = raw_damage * STAB_BONUS / EFF_SCALING;
        };

        // Now apply the damage to the defender (can get to 0, safe operation)
        stats::decrease_hp(defender, raw_damage);
    }
}
