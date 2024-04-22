# CLI

This folder contains the source code for the command line interface (CLI) of the
project. The main goal of CLIs is to demonstrate the order of transactions, how
they're run as well as to serve as a good-to-go scripts for more advanced UIs.

## Prerequisites

As for most JS projects, you need:

- node v20+
- npm / pnpm

## Install & Use

```bash
pnpm i # npm i

node v1/pvb create-arena # play against a bot

node v1/pvp create-arena # play against another player
node v1/pvp join <arena> # join an arena created by another player
node v1/pvp search       # search last 10 created arenas and check if they're available
```

_Please, note, that for usability purposes the CLI scripts are creating a temporary keystore, this is merely an easier setup practice and should not be used in production. We all want things to work out of the box but key management is not something to ignore_

## Play with yourself

> Option for the lonely ones

To play on the same machine, you need two accounts. For that, use `KEYSTORE=path.to.keystore` env variable before running a script. Even for empty path a new keystore will be created and gas will automagically be requested from faucet.

```bash
KEYSTORE=.new.keystore node v1/pvp create-arena
KEYSTORE=.another.keystore node v1/pvp join <arena>
```

Have fun playing!
