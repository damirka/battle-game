// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Ed25519Keypair } from "@mysten/sui.js/keypairs/ed25519";
import { SuiClient, getFullnodeUrl } from "@mysten/sui.js/client";
import { requestSuiFromFaucetV1, getFaucetHost } from "@mysten/sui.js/faucet";
import { fromB64 } from "@mysten/sui.js/utils";
import { program } from "commander";
import { TransactionBlock } from "@mysten/sui.js/transactions";
import inquirer from "inquirer";
import * as fs from "fs";
import { decodeSuiPrivateKey } from "@mysten/sui.js/cryptography";

// === Sui Devnet Environment ===

const pkg = "0x794aad4b42d93bc0fe5af808424d2c9603da01318de55ed02e34ce69cfb305ec";

/** The built-in client for the application */
const client = new SuiClient({ url: getFullnodeUrl("testnet") });

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

// const account = decodeSuiPrivateKey()

// === CLI Bits ===

program
  .name("capymon-devnet-player-vs-bot")
  .description("A prototype for Capymon on devnet")
  .version("0.0.1");

program
  .command("fight")
  .description("Create an arena and fight against a bot")
  .action(createArena);

program.parse(process.argv);

// === Commands / Actions ===

/** Create an arena and wait for another player */
async function createArena() {
  await checkOrRequestGas();

  // Run the create arena transaction

  let tx = new TransactionBlock();
  tx.moveCall({ target: `${pkg}::arena::new` });
  let result = await signAndExecute(tx);
  let event = result.events[0].parsedJson;

  let gasData = result.objectChanges.find((o) =>
    o.objectType.includes("sui::SUI")
  );
  let arenaData = result.objectChanges.find((o) =>
    o.objectType.includes("arena::Arena")
  );

  console.log("Arena Created", event.arena);
  console.table([
    { name: "Player", ...event.player_stats },
    { name: "Bot", ...event.bot_stats },
  ]);

  console.log('- Fire is strong against water');
  console.log('- Earth is strong against fire');
  console.log('- Water is strong against earth');

  // We need this buddy for further calls.
  const arenaObj = {
    mutable: true,
    objectId: arenaData.objectId,
    initialSharedVersion: arenaData.version,
  };

  let gasObj = {
    digest: gasData.digest,
    objectId: gasData.objectId,
    version: gasData.version,
  };

  while (true) {
    const { move } = await inquirer.prompt([
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
    ]);

    let tx = new TransactionBlock();

    // we don't use automatic gas selection for performance reasons; having an
    // extra HTTP query to set gas payment is not worth it for a prototype
    tx.setGasPayment([gasObj]);
    tx.setGasBudget("100000000");
    tx.moveCall({
      target: `${pkg}::arena::attack`,
      arguments: [tx.sharedObjectRef(arenaObj), tx.pure(move, "u8")],
    });

    let result = await signAndExecute(tx);
    let gasData = result.objectChanges.find((o) =>
      o.objectType.includes("sui::SUI")
    );
    let event = result.events.map((e) => e.parsedJson)[0];

    // update gas version and digest to not fetch it again
    gasObj = {
      digest: gasData.digest,
      objectId: gasData.objectId,
      version: gasData.version,
    };

    console.log(event);

    if (event && event.bot_hp == '0') {
      return console.log("You won!");
    }

    if (event && event.player_hp == '0') {
      return console.log("You lost!");
    }

    (event) && console.table([
      { name: "Player", HP: +event.player_hp / 100000000 },
      { name: "Bot", HP: +event.bot_hp / 100000000 },
    ]);
  }
}

/** Sign the TransactionBlock and send the tx to the network */
function signAndExecute(tx) {
  return client.signAndExecuteTransactionBlock({
    signer: keypair,
    transactionBlock: tx,
    options: {
      showEffects: true,
      showObjectChanges: true,
      showEvents: true,
    },
  });
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
