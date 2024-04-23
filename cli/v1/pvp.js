// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Ed25519Keypair } from "@mysten/sui.js/keypairs/ed25519";
import { SuiClient, SuiHTTPTransport, getFullnodeUrl } from "@mysten/sui.js/client";
import { requestSuiFromFaucetV1, getFaucetHost } from "@mysten/sui.js/faucet";
import { bcs } from "@mysten/sui.js/bcs";
import {
  formatAddress,
  fromB64,
  isValidSuiObjectId,
} from "@mysten/sui.js/utils";
import { program } from "commander";
import { TransactionBlock } from "@mysten/sui.js/transactions";
import inquirer from "inquirer";
import blake2b from "blake2b";
import * as fs from "fs";
import { promisify } from "util";
import { decodeSuiPrivateKey } from "@mysten/sui.js/cryptography";

const wait = promisify(setTimeout);

// === Sui Devnet Environment ===

const pkg =
  "0x794aad4b42d93bc0fe5af808424d2c9603da01318de55ed02e34ce69cfb305ec";

const Stats = bcs.struct('Stats', {
  hp: bcs.u64(),
  attack: bcs.u8(),
  defence: bcs.u8(),
  specialAttack: bcs.u8(),
  specialDefence: bcs.u8(),
  speed: bcs.u8(),
  level: bcs.u8(),
  types: bcs.vector(bcs.u8())
});

const Round = bcs.struct('RoundResult', {
  playerOneHp: bcs.u64(),
  playerTwoHp: bcs.u64(),
  playerOneMove: bcs.u8(),
  playerTwoMove: bcs.u8()
});

const Player = bcs.struct('Player', {
  startingHp: bcs.u64(),
  stats: Stats,
  account: bcs.Address,
  nextAttack: bcs.option(bcs.vector(bcs.u8())),
  lastMove: bcs.option(bcs.u8()),
  nextRound: bcs.u8()
});

const Arena = bcs.struct('Arena', {
  id: bcs.Address,
  seed: bcs.vector(bcs.u8()),
  round: bcs.u8(),
  playerOne: Player,
  playerTwo: bcs.option(Player),
  winner: bcs.option(bcs.Address),
  history: bcs.vector(Round)
});

/** The built-in client for the application */
const client = new SuiClient({
  // url: getFullnodeUrl("testnet"),
  transport: new SuiHTTPTransport({
    url: getFullnodeUrl("testnet"),
  }),
});

/** The private key for the address; only for testing purposes */
const myKey = {
  schema: null,
  privateKey: null,
};

const TEMP_KEYSTORE = process.env.KEYSTORE || "./.temp.keystore.json";

// use a local keypair for testing purposes
if (fs.existsSync(TEMP_KEYSTORE)) {
  console.log("Found local keypair, using it");
  const keystore = JSON.parse(fs.readFileSync(TEMP_KEYSTORE, "utf8"));
  const { secretKey, schema } = decodeSuiPrivateKey(keystore);
  myKey.privateKey = secretKey;
  myKey.schema = schema;
} else {
  console.log("Creating a temp account for testing purposes");
  const keypair = Ed25519Keypair.generate();
  fs.writeFileSync(TEMP_KEYSTORE, JSON.stringify(keypair.getSecretKey()));
  myKey.privateKey = decodeSuiPrivateKey(keypair.getSecretKey());
  myKey.schema = keypair.getKeyScheme();
}

const keypair = Ed25519Keypair.fromSecretKey(myKey.privateKey);
const address = keypair.toSuiAddress();

// === Events ===

const ArenaCreated = `${pkg}::arena_pvp::ArenaCreated`;

// === CLI Bits ===

program
  .name("capymon-devnet-player-vs-player")
  .description("A prototype for Capymon on devnet")
  .version("0.0.1");

program
  .command("create-arena")
  .description("Create an arena; then wait for another player to join")
  .action(createArena);

program
  .command("join <arenaId>")
  .description("Join an arena")
  .action(joinArena);

program.command("search").description("Search for arenas").action(searchArenas);

program.parse(process.argv);

// === Moves ===

const Moves = ["Fire", "Earth", "Water"];

// === Commands / Actions ===

async function joinArena(arenaId) {
  await checkOrRequestGas();

  if (!isValidSuiObjectId(arenaId)) {
    throw new Error(`Invalid arena ID: ${arenaId}`);
  }

  let arenaFetch = await client.getObject({
    id: arenaId,
    options: { showOwner: true, showContent: true },
  });

  // In case fetching went wrong, error out.
  if ("error" in arenaFetch) {
    throw new Error(`Could not fetch arena: ${arenaFetch.error}`);
  }

  // Although Arena is always shared, let's do a check anyway.
  if (!"Shared" in arenaFetch.data.owner) {
    throw new Error(`Arena is not shared`);
  }

  let rejoin = false;
  let fields = arenaFetch.data.content.fields;
  let player_one = fields.player_one.fields.account;

  // Check if the arena is full; if not - join; if it's the current account
  // that is the player_two - rejoin.
  if (fields.player_two !== null) {
    if (fields.player_two.fields.account !== address) {
      throw new Error(`Arena is full, second player is there...`);
    }

    rejoin = true;
  }

  // Use the fetched data to not fetch Arena object ever again.
  let initialSharedVersion =
    arenaFetch.data.owner.Shared.initial_shared_version;

  // Prepare the Arena object; shared and the insides never change.
  let arena = {
    mutable: true,
    objectId: arenaId,
    initialSharedVersion,
  };

  let gasObj = null;

  console.log("\nTip:");
  console.log("- Fire is strong against water");
  console.log("- Earth is strong against fire");
  console.log("- Water is strong against earth...\n");

  // Currently we only expect 1 scenario - join and compete to the end. So no
  // way to leave the arena and then rejoin. And the game order is fixed.
  if (!rejoin) {
    let { result, gas } = await join(arena);
    gasObj = gas;

    if ("errors" in result) {
      throw new Error(`Could not join arena: ${result.errors}`);
    }

    console.log("Joined!");
  } else {
    console.log("Rejoined!");
  }

  let { p1, p2 } = await getStats(arena.objectId);
  console.table([p1, p2]);

  while (true) {
    console.log("[NEXT ROUND]");
    let { gas } = await fullRound(arena, address, player_one, gasObj);
    gasObj = gas;
  }
}

/** Create an arena and wait for another player */
async function createArena() {
  await checkOrRequestGas();

  // Run the create arena transaction

  let tx = new TransactionBlock();
  tx.moveCall({ target: `${pkg}::arena_pvp::new` });
  let { result, gas } = await signAndExecute(tx);
  let gasObj = gas;

  // console.log('created with gas: %o', gasObj);

  let event = result.events[0].parsedJson;
  let arenaData = result.objectChanges.find((o) =>
    o.objectType.includes("arena_pvp::Arena")
  );

  console.log("Arena Created", event.arena);

  console.log("\nTip:");
  console.log("- Fire is strong against water");
  console.log("- Earth is strong against fire");
  console.log("- Water is strong against earth...\n");

  /* The Arena object; shared and never changes */
  const arena = {
    mutable: true,
    objectId: arenaData.objectId,
    initialSharedVersion: arenaData.version,
  };

  // Now wait until another player joins. This is a blocking call.
  console.log("Waiting for another player to join...");

  /** @type Arena */
  let game = await listenToArenaEvents(arena.objectId, (arena) => {
    if (arena.playerTwo !== null) {
      return arena;
    }
  });

  console.log("Player 2 joined! %s", game.playerTwo.account);
  console.log("Starting the battle!");

  console.table([game.playerOne, game.playerTwo]);

  while (true) {
    console.log("[NEXT ROUND]");
    let { gas } = await fullRound(arena, address, game.playerTwo.account, gasObj);
    gasObj = gas;
  }
}

/** Perform a single round of actions: commit, wait, reveal, repeat */
async function fullRound(arena, p1, p2, gasObj = null) {

  // start listening for the opponent's move and perform the move in parallel
  let p2Moved = listenToArenaEvents(arena.objectId, (arena) => {
    let player = arena.playerOne.account == p2 ? arena.playerOne : arena.playerTwo;
    if (player.nextAttack !== null) {
      return arena;
    }
  });

  let p1_move = await chooseMove();
  let { gas: cmtGas } = await commit(arena, p1_move, gasObj);
  gasObj = cmtGas;
  console.log("Commitment submitted!");

  let initialState = await p2Moved; // wait for the opponent to commit
  let meP1 = initialState.playerOne.account == p1;

  console.log("Both players have chosen a move. Revealing...");

  let p2_move = null;
  let round_res = null;
  let p2Revealed = listenToArenaEvents(arena.objectId, (arena) => {
    // Next round happened -ish
    if (arena.winner !== null || arena.history.length == initialState.history.length + 1) {
      round_res = arena.history[arena.history.length - 1];
      return arena;
    }
  });

  let { gas: rvlGas } = await reveal(arena, p1_move, gasObj);
  gasObj = rvlGas;
  console.log("Revealed!");

  let newState = await p2Revealed;

  console.log("Both players have revealed their moves. Results are in!");
  console.table([
    {
      name: "You",
      hp: formatHP(meP1 ? round_res.playerOneHp : round_res.playerTwoHp),
      move: Moves[meP1 ? round_res.playerOneMove : round_res.playerTwoMove],
    },
    {
      name: "Opponent",
      hp: formatHP(meP1 ? round_res.playerTwoHp : round_res.playerOneHp),
      move: Moves[meP1 ? round_res.playerTwoMove : round_res.playerOneMove],
    },
  ]);

  if (newState.winner) {
    (newState.winner == p1)
      ? console.log("Congratulations! You won!")
      : console.log("Game over! You lost!");
    process.exit(0);
  }

  return { gas: gasObj };
}

/** Search for recently created Arenas; look for those empty */
async function searchArenas() {
  let { data, error } = await client.queryEvents({
    query: { MoveEventType: ArenaCreated },
    order: "descending",
  });
  if (!data) {
    return console.log("An error occurred");
  }

  let search = data
    .slice(0, 5)
    .map((e) => ({
      arena: e.parsedJson.arena,
      created: Date.now() - e.timestampMs,
    }))
    .filter((e) => e.created < 120000); // 2 minutes

  let byTime = search.reduce(
    (acc, v) => ({ ...acc, [v.arena]: v.created }),
    {}
  );
  let query = search.map(({ arena }) =>
    client.getObject({ id: arena, options: { showBcs: true } })
  );
  let arenas = (await Promise.all(query))
    .filter((e) => !!e.data)
    .map((e) => ({ objectId: e.data.objectId, content: Arena.parse(fromB64(e.data.bcs.bcsBytes)) }))
    .filter((e) => e.content.playerTwo === null);

  if (arenas.length == 0) {
    let { create } = await inquirer.prompt([
      {
        type: "confirm",
        name: "create",
        message: "No arenas found, create one?",
        prefix: ">",
      },
    ]);

    if (create) {
      return createArena();
    } else {
      return console.log("See you next time!");
    }
  }

  let { arena } = await inquirer.prompt([
    {
      type: "list",
      name: "arena",
      prefix: ">",
      message: "Choose an arena",
      choices: arenas.map((e) => ({
        name: `${formatAddress(e.objectId)} (created ${(
          byTime[e.objectId] / 1000
        ).toFixed("0")}s ago}`,
        value: e.objectId,
      })),
    },
  ]);

  return joinArena(arena);
}

// === Transactions ===

/** Submit a commitment with an attack */
function commit(arena, move, gas = null) {
  let data = new Uint8Array([move, 1, 2, 3, 4]);
  let hash = Array.from(blake2b(32).update(data).digest());

  let tx = new TransactionBlock();
  tx.moveCall({
    target: `${pkg}::arena_pvp::commit`,
    arguments: [tx.sharedObjectRef(arena), tx.pure(hash, "vector<u8>")],
  });
  return signAndExecute(tx, gas);
}

/** Reveal the commitment by providing the Move and Salt */
function reveal(arena, move, gas = null) {
  let tx = new TransactionBlock();
  tx.moveCall({
    target: `${pkg}::arena_pvp::reveal`,
    arguments: [
      tx.sharedObjectRef(arena),
      tx.pure(move, "u8"),
      tx.pure([1, 2, 3, 4], "vector<u8>"),
    ],
  });
  return signAndExecute(tx, gas);
}

/** Join the arena if not yet */
function join(arena, gas = null) {
  let tx = new TransactionBlock();
  tx.moveCall({
    target: `${pkg}::arena_pvp::join`,
    arguments: [tx.sharedObjectRef(arena)],
  });

  return signAndExecute(tx, gas);
}

// === Fetching and Listening ===

/** Fetch current stats of both players */
async function getStats(arenaId) {
  let object = await client.getObject({
    id: arenaId,
    options: { showContent: true },
  });
  let fields = object.data.content.fields;

  let p1 =
    fields.player_one.fields.account == address
      ? fields.player_one.fields.stats.fields
      : fields.player_two.fields.stats.fields;

  let p2 =
    fields.player_one.fields.account == address
      ? fields.player_two.fields.stats.fields
      : fields.player_one.fields.stats.fields;

  p1 = { name: "You", HP: formatHP(p1.hp), ...p1 };
  p2 = { name: "Opponent", HP: formatHP(p2.hp), ...p2 };

  p1.types = p1.types.map((type) => Moves[type]);
  p2.types = p2.types.map((type) => Moves[type]);

  return { p1, p2 };
}

function formatHP(hp) {
  return +(hp / 100000000).toFixed(2);
}

/**
 * Subscribe to all emitted events for a specified arena
 * @param {string} arenaId
 * @param {(arena: Arena) => void | any} cb
 */
async function listenToArenaEvents(arenaId, cb) {
  const fetch = await client.getObject({ id: arenaId, options: { showBcs: true }});
  const bytes = fromB64(fetch.data.bcs.bcsBytes);
  const arena = Arena.parse(bytes);

  let res = cb(arena);
  if (typeof res !== "undefined") {
    return res;
  }

  return listenToArenaEvents(arenaId, cb);
}

/** Sign the TransactionBlock and send the tx to the network */
async function signAndExecute(tx, gasObj = null) {
  if (gasObj) {
    tx.setGasPayment([gasObj]);
    tx.setGasBudget("100000000");
    tx.setGasPrice(1000);
  }

  const result = await client.signAndExecuteTransactionBlock({
    signer: keypair,
    transactionBlock: tx,
    options: {
      showEffects: true,
      showObjectChanges: true,
      showEvents: true,
    },
  });

  return {
    result,
    gas: result.effects.gasObject.reference,
  };
}

/** Prompt a list to the user */
function chooseMove() {
  return inquirer
    .prompt([
      {
        type: "list",
        name: "move",
        prefix: ">",
        message: "Choose your move",
        choices: [
          { name: "Fire", value: 0 },
          { name: "Earth", value: 1 },
          { name: "Water", value: 2 },
        ],
      },
    ])
    .then((res) => res.move);
}

/** Hang until the cb is truthy */
async function waitUntil(cb) {
  const wait = () => new Promise((resolve) => setTimeout(resolve, 500));
  await (async function forever() {
    if (cb()) {
      return;
    }

    return wait().then(forever);
  })();
}

/** Check that the account has at least 1 coin, if not - request from faucet */
async function checkOrRequestGas() {
  console.log("Checking for gas...");
  let coins = await client.getCoins({ owner: address });
  if (coins.data.length == 0) {
    console.log("No gas found; requesting from faucet... (wait 60s)");
    await requestFromFaucet();
    setTimeout(() => console.log("It's been 10s..."), 10000);
    setTimeout(() => console.log("It's been 30s..."), 30000);
    setTimeout(() => console.log("It's been 60s..."), 60000);
    return new Promise((resolve) => setTimeout(resolve, 60000));
  }
  console.log("All good!");
}

/** Request some SUI to the main address */
function requestFromFaucet() {
  return requestSuiFromFaucetV1({
    host: getFaucetHost("testnet"),
    recipient: address,
  });
}
