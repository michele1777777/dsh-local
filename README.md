# dsh-local

English | [中文](README.zh.md)

dsh-local is a local-first distribution of DSH, built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It is maintained independently and is not affiliated with or endorsed by DeepSeek.

<a id="about-this-distribution"></a>
## About this distribution

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com), built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis). dsh-local keeps its code and adds an interactive terminal app, profile layers for models served on your own hardware, context pruning with a decision model, and Exa and Tavily web search. [Run on local models](docs/user/guide/local-first.md) describes the setup. Everything else follows upstream, whose documentation is at [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/).

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly, and dsh-local follows it. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

<a id="run"></a>
## Run

<a id="run-from-source"></a>
### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/michele1777777/dsh-local.git
cd dsh-local
pnpm install
pnpm run build
pnpm dsh
```

`pnpm dsh` opens the terminal app and `pnpm dsh web` the Web UI; both use the built artifacts without rebuilding. To start `dsh` from any directory, run `bash scripts/install-dsh-linux.sh` once on Linux, or follow [On Windows](docs/user/guide/local-first.md#on-windows). The [local models guide](docs/user/guide/local-first.md) connects a model server, and the [Web UI guide](docs/user/guide/index.md) continues from a running Web UI.

## Community and support

- Report bugs and suggestions for dsh-local through [GitHub Issues](https://github.com/michele1777777/dsh-local/issues).
- Report problems that also occur in DeepSeek Harness upstream, through its [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

To cite the harness, cite DeepSeek Harness:

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE), as upstream.

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
