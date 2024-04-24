# Sui Pokemon

This is an example implementation of the Pokemon damage formula v1 on Sui with a simple example of a game that uses it in 2 modes: single player (vs bot) and multiplayer.

## How to use

You can either play the prototype on testnet by looking into [cli](./cli) folder or use the library in your own project. The algorithm is not yet published on any of the environments, so you need to include it as a dependency and either publish separately or together with your package.

```toml
[dependencies]
Sui = { git = "https://github.com/damirka/pokemon.git", subdir = "packages/pokemon", rev = "main" }
```

## Want to play?

Package is live on testnet. Go to [CLI](./cli) for a guide.

## License

[Apache 2.0](./LICENSE)
