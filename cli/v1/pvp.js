// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Ed25519Keypair } from "@mysten/sui.js/keypairs/ed25519";
import { SuiClient, getFullnodeUrl } from "@mysten/sui.js/client";
import { requestSuiFromFaucetV1, getFaucetHost } from "@mysten/sui.js/faucet";
import { fromB64, isValidSuiObjectId } from "@mysten/sui.js/utils";
import { program } from "commander";
import { TransactionBlock } from "@mysten/sui.js/transactions";
import inquirer from "inquirer";
import blake2b from "blake2b";
import * as fs from "fs";

// === Sui Devnet Environment ===

const pkg = "0xaf14ba71cdb56a1b9ec162874cb047ff6882b82d930c0541daf50eb4e94b5a99";

/** The built-in client for the application */
const client = new SuiClient({ url: getFullnodeUrl("devnet") });

/** The private key for the address; only for testing purposes */
const myKey = {
  schema: null,
  privateKey: null,
};

const TEMP_KEYSTORE = process.env.KEYSTORE || "./.temp.keystore.json";

// use a local keypair for testing purposes
if (fs.existsSync(TEMP_KEYSTORE)) {
  console.log('Found local keypair, using it');
  const keystore = JSON.parse(fs.readFileSync(TEMP_KEYSTORE, 'utf8'));
  myKey.privateKey = keystore.privateKey;
  myKey.schema = keystore.schema;
} else {
  console.log('Creating a temp account for testing purposes');
  const keypair = Ed25519Keypair.generate().export();
  myKey.privateKey = keypair.privateKey;
  myKey.schema = keypair.schema;
  fs.writeFileSync(TEMP_KEYSTORE, JSON.stringify(myKey));
}

const keypair = Ed25519Keypair.fromSecretKey(fromB64(myKey.privateKey));
const address = keypair.toSuiAddress();

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

program
  .command("search")
  .description("Search for arenas")
  .action(searchArenas);

program.parse(process.argv);

// === Events ===

const ArenaCreated = `${pkg}::arena_pvp::ArenaCreated`;
const PlayerJoined = `${pkg}::arena_pvp::PlayerJoined`;
const PlayerCommit = `${pkg}::arena_pvp::PlayerCommit`;
const PlayerReveal = `${pkg}::arena_pvp::PlayerReveal`;
const RoundResult = `${pkg}::arena_pvp::RoundResult`;

// === Moves ===

const Moves = ["Rock", "Paper", "Scissors"];

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

  console.log('created with gas: %o', gasObj);

  let event = result.events[0].parsedJson;
  let arenaData = result.objectChanges.find((o) =>
    o.objectType.includes("arena_pvp::Arena")
  );

  console.log("Arena Created", event.arena);

  /* The Arena object; shared and never changes */
  const arena = {
    mutable: true,
    objectId: arenaData.objectId,
    initialSharedVersion: arenaData.version,
  };

  // Now wait until another player joins. This is a blocking call.
  console.log("Waiting for another player to join...");

  let player_two = null;
  let joinUnsub = await listenToArenaEvents(arena.objectId, (event) => {
    event.type === PlayerJoined && (player_two = event.sender);
  });

  await waitUntil(() => player_two !== null);
  await joinUnsub();

  console.log("Player 2 joined! %s", player_two);
  console.log("Starting the battle!");

  let { p1, p2 } = await getStats(arena.objectId);
  console.table([p1, p2]);

  while (true) {
    console.log("[NEXT ROUND]");
    let { gas } = await fullRound(arena, address, player_two, gasObj);
    gasObj = gas;
  }
}

/** Perform a single round of actions: commit, wait, reveal, repeat */
async function fullRound(arena, player_one, player_two, gasObj = null) {
  let p2_moved = false;
  let moveUnsub = await listenToArenaEvents(arena.objectId, (event) => {
    if (event.sender === player_two && event.type === PlayerCommit) {
      p2_moved = true;
    }
  });

  let p1_move = await chooseMove();
  let { gas: cmtGas } = await commit(arena, p1_move, gasObj);
  gasObj = cmtGas;
  console.log("Commitment submitted!");

  await waitUntil(() => p2_moved);
  await moveUnsub();

  console.log("Both players have chosen a move. Revealing...");

  let round_res = null;
  let p2_move = null;
  let roundUnsub = await listenToArenaEvents(arena.objectId, (event) => {
    if (event.type === PlayerReveal && event.sender === player_two) {
      p2_move = event.parsedJson._move;
    }

    if (event.type === RoundResult) {
      round_res = {
        attacker: event.sender,
        attacker_hp: event.parsedJson.attacker_hp,
        defender_hp: event.parsedJson.defender_hp,
      };
    }
  });

  let { gas: rvlGas } = await reveal(arena, p1_move, gasObj);
  gasObj = rvlGas;
  console.log("Revealed!");

  await waitUntil(() => !!round_res);
  await roundUnsub();

  if (round_res.attacker === player_one) {
    console.table([
      {
        name: "You",
        hp: formatHP(round_res.attacker_hp),
        move: Moves[p1_move],
      },
      {
        name: "Opponent",
        hp: formatHP(round_res.defender_hp),
        move: (p2_move && Moves[p2_move]) || "Network Failure",
      },
    ]);
  } else {
    console.table([
      {
        name: "You",
        hp: formatHP(round_res.defender_hp),
        move: Moves[p1_move],
      },
      {
        name: "Opponent",
        hp: formatHP(round_res.attacker_hp),
        move: (p2_move && Moves[p2_move]) || "Network Failure",
      },
    ]);
  }

  if (round_res.attacker_hp == 0 || round_res.defender_hp == 0) {
    if (address == round_res.attacker) {
      if (round_res.attacker_hp == 0) {
        console.log("Game over! You lost!");
      } else {
        console.log("Congratulations! You won!");
      }
    } else {
      if (round_res.attacker_hp == 0) {
        console.log("Congratulations! You won!");
      } else {
        console.log("Game over! You lost!");
      }
    }

    process.exit(0);
  }

  return { gas: gasObj };
}

function searchArenas() {

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

/** Subscribe to all emitted events for a specified arena */
function listenToArenaEvents(arenaId, cb) {
  return client.subscribeEvent({
    filter: {
      All: [
        { MoveModule: { module: "arena_pvp", package: pkg } },
        { MoveEventModule: { module: "arena_pvp", package: pkg } },
        { Package: pkg },
      ],
    },
    onMessage: (event) => {
      let cond =
        event.packageId == pkg &&
        event.transactionModule == "arena_pvp" &&
        event.parsedJson.arena == arenaId;

      if (cond) {
        cb(event);
      } else {
        console.log("Not tracked: %o", event);
      }
    },
  });
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
          { name: "Rock", value: 0 },
          { name: "Paper", value: 1 },
          { name: "Scissors", value: 2 },
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
    console.log("No gas found; requesting from faucet... (wait 20s)");
    await requestFromFaucet();
    setTimeout(() => console.log("It's been 10s..."), 10000);
    return new Promise((resolve) => setTimeout(resolve, 20000));
  }
  console.log("All good!");
}

/** Request some SUI to the main address */
function requestFromFaucet() {
  return requestSuiFromFaucetV1({
    host: getFaucetHost("devnet"),
    recipient: address,
  });
}
