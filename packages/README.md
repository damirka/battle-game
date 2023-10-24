# Move Packages

This directory contains the source code for the Move packages of the project.
The `pokemon` package is expected to be reused across different versions of the
project.

## Prerequisites

- [Sui CLI](https://docs.sui.io/testnet/build/install)

Quick tip for Rust developers (cargo installed):
```
cargo install --locked --git https://github.com/MystenLabs/sui.git --branch devnet sui
```

## Publish & Use

```bash
cd game-v1

sui client publish \
    --gas-budget 1000000000 \
    --skip-dependency-verification \
    --with-unpublished-dependencies

# use the results of the publishing (like packageId) and set the environment
# variables in one of the CLI scripts (e.g. `cli/v1/pvb.js`)
```

**Notes**

- `--skip-dependency-verification` omits warnings if Sui Framework changed
- `--with-unpublished-dependencies` publishes all dependencies together with
the main package. Although it is not a recommended practice for package
reusability for devnet and prototyping purposes it is a good-to-go option.
