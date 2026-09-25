# Ogre MCP

Ogre MCP (Open Game Relay Engine, `ogremcp`) connects a video game to any AI agent through one remote MCP server, so the agent can read your live game state and give spoiler-free guidance. The design is in [`docs/architecture.md`](docs/architecture.md).

## Layout

| Path | Contents | License |
|---|---|---|
| `packages/sdk/` | `@ogremcp/sdk`: manifest schema, `Interpreter` interface, shared types | MIT |
| `kits/wow/` | `@ogremcp/kit-wow`: WoW adapter, manifest, interpreter, fixtures | MIT |
| `platform/` | `@ogremcp/platform`: service, web UI, MCP server, bridge API, OAuth server | AGPL-3.0-or-later |
| `bridge/` | Go module: the bridge that runs on the player's PC | MIT |

## Self-host

To run your own server with Docker Compose, see [`docs/self-host.md`](docs/self-host.md).

## License

Each of the four paths above has its own `LICENSE` file. `platform/` is licensed under the GNU Affero General Public License v3.0 or later. `packages/sdk/`, `kits/wow/`, and `bridge/` are licensed under the MIT License. Every file outside those four paths is licensed under the MIT License in the root [`LICENSE`](LICENSE).

## Contributing

Contributions use the [Developer Certificate of Origin](https://developercertificate.org/) (DCO), not a CLA. Sign off every commit with `git commit -s`. CI fails a pull request if any of its commits lacks a `Signed-off-by:` line that matches the commit author's name and email.
