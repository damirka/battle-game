// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/// Arena module.
module prototype::arena_pvp {
    use std::vector;
    use std::option::{Self, Option};

    use sui::tx_context::{Self, TxContext};
    use sui::object::{Self, UID};
    use sui::transfer;
    use sui::bcs;

    use pokemon::stats::{Self, Stats};
    use prototype::battle;

    /// Trying to perform an action while still searching for P2;
    const EArenaNotReady: u64 = 0;
    /// Trying to perform an action while the arena is over;
    const EArenaOver: u64 = 1;
    /// Can't do next round if P1 hasn't submitted their move;
    const EPlayerOneNotReady: u64 = 2;
    /// Trying to attack while Move is already there.
    const EMoveAlreadySubmitted: u64 = 3;
    /// Not a Player.
    const EUnknownSender: u64 = 4;
    /// Invalid commitment; the hash of the move doesn't match the commitment.
    const EInvalidCommitment: u64 = 5;
    /// Same player tries to join the arena.
    const EYouCantTrickMe: u64 = 6;

    /// Struct containing information about the Player.
    struct Player has store, drop {
        /// The starting HP of the Player's Pokemon.
        starting_hp: u64,
        /// The stats of the Player's Pokemon.
        stats: Stats,
        /// The player's address.
        account: address,
        /// Stores the hashed move.
        next_attack: Option<vector<u8>>,
        /// Helps track the round. So that a second reveal can be performed
        /// without rushing into async execution.
        next_round: u8
    }

    ///
    struct Arena has key {
        id: UID,
        seed: vector<u8>,
        round: u8,
        /// Player1 is the one starting the Arena - so we alway have them.
        player_one: Player,
        /// Player2 is the one joining the Arena - so initally we don't have
        /// them. But they're free to join any time. As soon as they joined
        /// the battle can begin.
        player_two: Option<Player>,
        /// The winner of the battle.
        winner: Option<address>,
    }

    /// Emitted when a new Arena is created and available for joining.
    struct ArenaCreated has copy, drop { arena: address }
    /// Emitted when a player joins the Arena.
    struct PlayerJoined has copy, drop { arena: address }
    /// Emitted when a player commits the hit move.
    struct PlayerCommit has copy, drop { arena: address }
    /// Emitted when a player reveals the result and hits the other player.
    struct PlayerReveal has copy, drop {
        arena: address,
        _move: u8
    }
    /// Emitted when both players have hit and the round is over.
    struct RoundResult  has copy, drop {
        arena: address,
        attacker_hp: u64,
        defender_hp: u64
    }

    /// Create and share a new arena.
    entry fun new(ctx: &mut TxContext) {
        let arena = new_(ctx);

        sui::event::emit(ArenaCreated {
            arena: object::uid_to_address(&arena.id)
        });

        transfer::share_object(arena);
    }

    /// Join an existing arena and start the battle.
    entry fun join(arena: &mut Arena, ctx: &mut TxContext) {
        assert!(tx_context::sender(ctx) != arena.player_one.account, EYouCantTrickMe);

        let stats = generate_stats(derive(arena.seed, 1));

        option::fill(&mut arena.player_two, Player {
            starting_hp: stats::hp(&stats),
            stats: stats,
            account: tx_context::sender(ctx),
            next_attack: option::none(),
            next_round: 0
        });

        sui::event::emit(PlayerJoined {
            arena: object::uid_to_address(&arena.id)
        });
    }

    /// Attack the other player.
    entry fun commit(arena: &mut Arena, commitment: vector<u8>, ctx: &mut TxContext) {
        assert!(option::is_none(&arena.winner), EArenaOver);
        assert!(option::is_some(&arena.player_two), EArenaNotReady);

        let player = tx_context::sender(ctx);

        // If it's a P1 attack
        if (player == arena.player_one.account) {

            assert!(option::is_none(&arena.player_one.next_attack), EMoveAlreadySubmitted);
            arena.player_one.next_attack = option::some(commitment);

        } else if (player == option::borrow(&arena.player_two).account) {

            let p2 = option::borrow_mut(&mut arena.player_two);
            assert!(option::is_none(&p2.next_attack), EMoveAlreadySubmitted);
            p2.next_attack = option::some(commitment);

        } else {
            abort EUnknownSender // we don't know who you are
        };

        sui::event::emit(PlayerCommit {
            arena: object::uid_to_address(&arena.id)
        });
    }

    /// Each of the players needs to reveal their move; so that the round can
    /// be calculated. The last player to reveal bumps the round.
    entry fun reveal(
        arena: &mut Arena,
        _move: u8,
        salt: vector<u8>,
        ctx: &mut TxContext
    ) {
        assert!(option::is_some(&arena.player_two), EArenaNotReady);
        assert!(option::is_none(&arena.winner), EArenaOver);

        // The player that is revealing.
        let player = tx_context::sender(ctx);
        let _is_p1 = is_player_one(arena, player);

        // Get both players (mutably).
        let (attacker, defender) = if (is_player_one(arena, player)) {
            (&mut arena.player_one, option::borrow_mut(&mut arena.player_two))
        } else if (is_player_two(arena, player)) {
            (option::borrow_mut(&mut arena.player_two), &mut arena.player_one)
        } else {
            abort EUnknownSender // we don't know who you are
        };

        // Check if the player is allowed to reveal and if they haven't already.
        assert!(option::is_some(&attacker.next_attack), EPlayerOneNotReady);
        assert!(attacker.next_round == arena.round, EMoveAlreadySubmitted);

        let commitment = vector[ _move ];
        vector::append(&mut commitment, salt);
        let commitment = sui::hash::blake2b256(&commitment);

        assert!(&commitment == option::borrow(&attacker.next_attack), EInvalidCommitment);

        battle::attack(
            &attacker.stats,
            &mut defender.stats,
            (_move as u64),
            hit_rng(commitment, 2, arena.round),
            false
        );

        attacker.next_attack = option::none();
        attacker.next_round = arena.round + 1;

        // If both players have revealed, then the round is over; the last one
        // to reveal bumps the round.
        let next_round_cond = option::is_none(&defender.next_attack)
            && (defender.next_round == (arena.round + 1));

        sui::event::emit(PlayerReveal {
            arena: object::uid_to_address(&arena.id),
            _move: _move
        });

        // setting a winner means the battle is over
        if (stats::hp(&defender.stats) == 0) {
            arena.winner = option::some(attacker.account);
        };

        if (next_round_cond) {
            arena.round = arena.round + 1;
        };

        sui::event::emit(RoundResult {
            arena: object::uid_to_address(&arena.id),
            attacker_hp: stats::hp(&attacker.stats),
            defender_hp: stats::hp(&defender.stats),
        });
    }

    // === Internal ===

    fun is_player_one(arena: &Arena, player: address): bool {
        player == arena.player_one.account
    }

    fun is_player_two(arena: &Arena, player: address): bool {
        option::is_some(&arena.player_two) && (player == option::borrow(&arena.player_two).account)
    }

    /// Generate stats for a Pokemon from a seed.
    fun generate_stats(seed: vector<u8>): Stats {
        // let level = *vector::borrow(&seed, 8) % 10;
        // let level = if (level == 0) { 1 } else { level };
        let level = 10;
        stats::new(
            10 + smooth(*vector::borrow(&seed, 0)),
            smooth(*vector::borrow(&seed, 1)),
            smooth(*vector::borrow(&seed, 2)),
            smooth(*vector::borrow(&seed, 3)),
            smooth(*vector::borrow(&seed, 4)),
            smooth(*vector::borrow(&seed, 5)),
            level,
            vector[ *vector::borrow(&seed, 6) % 3 ]
        )
    }

    /// Generate a random number for a hit in the range [217; 255]
    fun hit_rng(seed: vector<u8>, path: u8, round: u8): u8 {
        let value = *vector::borrow(&derive(seed, path), (round as u64));
        ((value % (255 - 217)) + 217)
    }

    /// Smooth a value in the range [10; 50]
    fun smooth(value: u8): u8 {
        let value = ((value % 50) + 50) / 2;
        if (value < 10) {
            10
        } else {
            value
        }
    }

    /// Derive a new seed from a previous seed and a path.
    fun derive(seed: vector<u8>, path: u8): vector<u8> {
        vector::push_back(&mut seed, path);
        sui::hash::blake2b256(&seed)
    }

    /// Create a new arena.
    fun new_(ctx: &mut TxContext): Arena {
        let addr = tx_context::fresh_object_address(ctx);
        let seed = sui::hash::blake2b256(&bcs::to_bytes(&addr));
        let id = object::new(ctx);

        // Generate stats for player and bot.

        let player_stats = generate_stats(derive(seed, 0));

        // Emit events and share the Arena

        let player_one = Player {
            starting_hp: stats::hp(&player_stats),
            stats: player_stats,
            account: tx_context::sender(ctx),
            next_attack: option::none(),
            next_round: 0
        };

        let player_two = option::none();

        Arena {
            id, seed, player_one, player_two, round: 0, winner: option::none()
        }
    }

    #[test_only] use sui::test_scenario as ts;
    #[test_only] const ALICE: address = @0x1;
    #[test_only] const BOB: address = @0x2;
    #[test_only] const SALT: vector<u8> = b"this_is_salt";
    #[test_only] fun hashed_move(_move: u8): vector<u8> {
        let commitment = vector[ _move ];
        vector::append(&mut commitment, SALT);
        sui::hash::blake2b256(&commitment)
    }

    #[test] fun test_new_and_attack() {
        let scenario = ts::begin(ALICE);
        let test = &mut scenario;

        // Alice creates a new arena.
        ts::next_tx(test, ALICE); {
            new(ts::ctx(test));
        };

        // Bob joins the arena.
        ts::next_tx(test, BOB); {
            let arena = ts::take_shared<Arena>(test);
            join(&mut arena, ts::ctx(test));

            assert!(option::is_some(&arena.player_two), 0);
            assert!(option::borrow(&arena.player_two).next_round == 0, 1);
            assert!(arena.round == 0, 2);

            ts::return_shared(arena);
        };

        // Alice submits a committed move
        ts::next_tx(test, ALICE); {
            let arena = ts::take_shared<Arena>(test);
            commit(&mut arena, hashed_move(0), ts::ctx(test));

            assert!(option::is_some(&arena.player_one.next_attack), 0);
            assert!(arena.player_one.next_round == 0, 1);
            assert!(arena.round == 0, 2);

            ts::return_shared(arena);
        };

        // Bob submits a committed move.
        ts::next_tx(test, BOB); {
            let arena = ts::take_shared<Arena>(test);
            commit(&mut arena, hashed_move(1), ts::ctx(test));

            assert!(option::is_some(&option::borrow(&arena.player_two).next_attack), 0);
            assert!(option::borrow(&arena.player_two).next_round == 0, 1);
            assert!(arena.round == 0, 1);

            ts::return_shared(arena);
        };

        // Bob reveals the commitment.
        ts::next_tx(test, BOB); {
            let arena = ts::take_shared<Arena>(test);
            reveal(&mut arena, 1, SALT, ts::ctx(test));

            assert!(option::is_none(&option::borrow(&arena.player_two).next_attack), 0);
            assert!(option::borrow(&arena.player_two).next_round == 1, 1);
            assert!(arena.round == 0, 2);

            ts::return_shared(arena);
        };

        // Alice reveals the commitment; and the new round starts.
        ts::next_tx(test, ALICE); {
            let arena = ts::take_shared<Arena>(test);
            reveal(&mut arena, 0, SALT, ts::ctx(test));

            assert!(option::is_none(&arena.player_one.next_attack), 0);
            assert!(option::is_none(&option::borrow(&arena.player_two).next_attack), 1);
            assert!(arena.player_one.next_round == 1, 2);
            assert!(arena.round == 1, 3);

            ts::return_shared(arena);
        };

        // Bob attacks
        ts::next_tx(test, BOB); {
            let arena = ts::take_shared<Arena>(test);
            commit(&mut arena, hashed_move(2), ts::ctx(test));

            assert!(option::is_some(&option::borrow(&arena.player_two).next_attack), 0);
            assert!(option::borrow(&arena.player_two).next_round == 1, 1);
            assert!(arena.round == 1, 1);

            ts::return_shared(arena);
        };

        // Alice attacks
        ts::next_tx(test, ALICE); {
            let arena = ts::take_shared<Arena>(test);
            commit(&mut arena, hashed_move(1), ts::ctx(test));

            assert!(option::is_some(&arena.player_one.next_attack), 0);
            assert!(arena.player_one.next_round == 1, 1);
            assert!(arena.round == 1, 1);

            ts::return_shared(arena);
        };

        // Alice reveals the commitment.
        ts::next_tx(test, ALICE); {
            let arena = ts::take_shared<Arena>(test);
            reveal(&mut arena, 1, SALT, ts::ctx(test));

            assert!(option::is_none(&arena.player_one.next_attack), 0);
            assert!(arena.player_one.next_round == 2, 1);
            assert!(arena.round == 1, 2);

            ts::return_shared(arena);
        };

        // Bob reveals the commitment; and the new round starts.
        ts::next_tx(test, BOB); {
            let arena = ts::take_shared<Arena>(test);
            reveal(&mut arena, 2, SALT, ts::ctx(test));

            assert!(option::is_none(&option::borrow(&arena.player_two).next_attack), 0);
            assert!(option::borrow(&arena.player_two).next_round == 2, 1);
            assert!(arena.round == 2, 2);

            ts::return_shared(arena);
        };

        ts::end(scenario);
    }
}
